// Native Electron acceptance. Synthetic input only; never records the host mic.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../services/orchestrator/src/index.ts";

const require = createRequire(import.meta.url);
const { _electron: electron } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const desktopRequire = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const live = process.argv.includes("--live");
if (live && !process.env.OPENAI_API_KEY)
  throw new Error("OPENAI_API_KEY is required for --live");
const directory = await mkdtemp(join(tmpdir(), "molecule-voice-"));
const artifacts = resolve(process.env.VOICE_ARTIFACTS || "artifacts/voice");
await mkdir(artifacts, { recursive: true });
const solver = spawn(
  process.env.SOLVER_PYTHON || resolve("services/solver/.venv/bin/python"),
  [
    "-m",
    "uvicorn",
    "app.main:app",
    "--app-dir",
    "services/solver",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let app;
let desktop;
let phase = "solver";
const actionEvidence = [];
async function captureVoiceEvidence() {
  if (!desktop) return;
  const page = await desktop.firstWindow();
  const evidence = await page.evaluate(async () => {
    const bootstrap = await window.moleculeDesktop.bootstrap();
    const projectId = bootstrap.settings.lastProjectId;
    let project = null;
    if (projectId) {
      const response = await fetch(
        `${bootstrap.apiUrl}/api/projects/${projectId}`,
      );
      if (response.ok) {
        const result = await response.json();
        project = {
          orderId: result.project.orderId,
          state: result.project.state,
          revision: result.project.revision,
          planId: result.project.activePlan?.planId ?? null,
          executionReceiptPresent: Boolean(result.project.executionReceipt),
        };
      }
    }
    return {
      project,
      events: (window.voiceProbe?.events ?? [])
        .filter((event) =>
          [
            "conversation.item.input_audio_transcription.completed",
            "response.function_call_arguments.done",
          ].includes(event.type),
        )
        .map((event) => ({
          type: event.type,
          transcript: event.transcript,
          name: event.name,
          arguments: event.arguments,
          callId: event.call_id,
          responseId: event.response_id,
        })),
    };
  });
  await writeFile(
    join(artifacts, "approval-evidence.json"),
    JSON.stringify(
      {
        phase,
        syntheticInputOnly: true,
        externalCommerce: "mock",
        ...evidence,
        actions: actionEvidence,
      },
      null,
      2,
    ),
  );
}
try {
  const solverUrl = await new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Solver startup timed out")),
      30_000,
    );
    solver.once("error", reject);
    solver.once("exit", (code) => reject(new Error(`Solver exited (${code})`)));
    solver.stderr.on("data", (chunk) => {
      const url = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) {
        clearTimeout(timeout);
        resolveUrl(url);
      }
    });
  });
  Object.assign(process.env, {
    SOLVER_URL: solverUrl,
    DATA_DIR: join(directory, "data"),
    STORAGE_MODE: "local",
    USE_MOCK_OPENAI: String(!live),
    DEMO_MODE: "true",
    BACKBOARD_MODE: "demo",
    SHOPIFY_MODE: "demo",
    REAL_EXECUTION_ENABLED: "false",
  });
  ({ app } = await createApp());
  app.addHook("preHandler", async (request) => {
    if (request.method !== "POST" || !request.url.endsWith("/actions")) return;
    const body = request.body;
    if (!body || typeof body !== "object" || !body.command) return;
    actionEvidence.push({
      actionId: body.actionId,
      command: body.command,
      originalText: body.originalText,
    });
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const args = [
    resolve("apps/desktop"),
    `--user-data-dir=${join(directory, "profile")}`,
    "--use-fake-device-for-media-stream",
    "--no-proxy-server",
    "--use-fake-ui-for-media-stream",
  ];
  if (live) {
    if (!process.env.VOICE_TEST_WAV || !process.env.VOICE_TEST_NEXT_WAV)
      throw new Error(
        "Provide VOICE_TEST_WAV (request) and VOICE_TEST_NEXT_WAV (project status follow-up), each with a 6-second silent lead-in and silent tail",
      );
    args.push(
      `--use-file-for-fake-audio-capture=${resolve(process.env.VOICE_TEST_WAV)}`,
    );
  }
  phase = "launch";
  // Only the backend receives credentials. Electron receives configuration URLs.
  const { OPENAI_API_KEY: omitted, ...desktopEnv } = process.env;
  desktop = await electron.launch({
    executablePath: desktopRequire("electron"),
    args,
    env: { ...desktopEnv, ORCHESTRATOR_URL: address },
    timeout: 30_000,
  });
  await desktop.evaluate(({ BrowserWindow, ipcMain }) => {
    // OS authorization is explicitly simulated; capture uses Chromium's fake device.
    ipcMain.removeHandler("desktop:permissions");
    ipcMain.handle("desktop:permissions", () => ({
      microphone: "granted",
      screen: "denied",
    }));
    ipcMain.removeHandler("desktop:microphone");
    ipcMain.handle("desktop:microphone", () => true);
    const win = BrowserWindow.getAllWindows()[0];
    win.show();
    win.webContents.setAudioMuted(true);
  });

  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15_000);
  const pageErrors = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.loadingFailed", (data) =>
    console.error("network failure", data.errorText, data.blockedReason),
  );
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("renderer:", message.text());
  });
  page.on("requestfailed", (request) =>
    console.error(
      "request failed:",
      new URL(request.url()).pathname,
      request.failure()?.errorText,
    ),
  );
  await page.waitForSelector('button[aria-label="Start voice input"]');
  await page.getByRole("button", { name: "Expand Molecule" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("#voice-status")?.textContent ===
      "Ready when you are",
    null,
    { timeout: 20_000 },
  );
  const installProbe = async () =>
    page.evaluate(() => {
      const probe = {
        streams: [],
        contexts: [],
        peers: [],
        channel: null,
        messages: [],
        events: [],
        peak: 0,
        signals: [],
        states: [],
      };
      window.voiceProbe = probe;
      window.moleculeDesktop.onSignal((signal) => probe.signals.push(signal));
      new MutationObserver(() => {
        const state = document.querySelector("#voice-status")?.textContent;
        if (probe.states.at(-1) !== state) probe.states.push(state);
      }).observe(document.querySelector("#voice-status"), {
        subtree: true,
        childList: true,
        characterData: true,
      });
      const capture = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await capture(constraints);
        probe.streams.push(stream);
        return stream;
      };
      const Context = window.AudioContext;
      window.AudioContext = class extends Context {
        constructor(...args) {
          super(...args);
          probe.contexts.push(this);
        }
        createAnalyser() {
          const analyser = super.createAnalyser();
          const sample = analyser.getFloatTimeDomainData.bind(analyser);
          analyser.getFloatTimeDomainData = (values) => {
            sample(values);
            for (const value of values)
              probe.peak = Math.max(probe.peak, Math.abs(value));
          };
          return analyser;
        }
      };
      const Peer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Peer {
        constructor(...args) {
          super(...args);
          probe.peers.push(this);
        }
        createDataChannel(...args) {
          const channel = super.createDataChannel(...args);
          channel.addEventListener("message", (message) => {
            try {
              const event = JSON.parse(message.data);
              probe.events.push(event);
            } catch {}
          });
          return channel;
        }
      };
    });
  if (live) {
    const fixtures = await Promise.all(
      [process.env.VOICE_TEST_WAV, process.env.VOICE_TEST_NEXT_WAV].map(
        async (path) => (await readFile(path)).toString("base64"),
      ),
    );
    await page.evaluate((fixtures) => {
      const Context = window.AudioContext;
      navigator.mediaDevices.getUserMedia = async () => {
        const bytes = Uint8Array.from(
          atob(fixtures[window.voiceFixtureIndex || 0]),
          (character) => character.charCodeAt(0),
        );
        const context = new Context();
        const buffer = await context.decodeAudioData(bytes.buffer.slice(0));
        const destination = context.createMediaStreamDestination();
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        window.playVoiceFixture = async () => {
          await context.resume();
          source.start();
        };
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            source.disconnect();
            void context.close();
          };
        }
        return destination.stream;
      };
    }, fixtures);
  }
  await installProbe();
  if (!live) {
    await page.route("**/api/desktop/realtime-session", (route) =>
      route.fulfill({
        json: {
          value: "ephemeral-test",
          expiresAt: Math.floor(Date.now() / 1000) + 120,
        },
      }),
    );
    await page.route("https://api.openai.com/v1/realtime/calls", (route) =>
      route.fulfill({ body: "mock-answer" }),
    );
    await page.evaluate(() => {
      window.RTCPeerConnection = class {
        connectionState = "new";
        constructor() {
          window.voiceProbe.peers.push(this);
        }
        addTrack() {}
        createDataChannel() {
          const channel = {
            readyState: "connecting",
            onopen: null,
            onmessage: null,
            close() {
              this.readyState = "closed";
            },
            send(raw) {
              window.voiceProbe.messages.push(JSON.parse(raw));
            },
          };
          this.channel = channel;
          window.voiceProbe.channel = channel;
          return channel;
        }
        async createOffer() {
          return { type: "offer", sdp: "test" };
        }
        async setLocalDescription() {}
        async setRemoteDescription() {
          this.channel.readyState = "open";
          this.channel.onopen?.();
        }
        close() {
          this.connectionState = "closed";
        }
      };
    });
  }
  const status = () => page.locator("#voice-status").textContent();
  const waitStatus = async (expected) => {
    await page.waitForFunction(
      (expected) =>
        document.querySelector("#voice-status")?.textContent === expected,
      expected,
      { timeout: 25_000 },
    );
  };
  const emit = (event) =>
    page.evaluate(
      (event) =>
        window.voiceProbe.channel.onmessage({ data: JSON.stringify(event) }),
      event,
    );
  const waitFor = (callback, arg, timeout = 25_000) =>
    page.waitForFunction(callback, arg, { timeout, polling: 100 });
  const summaries = [];
  for (let session = 0; session < (live ? 2 : 10); session++) {
    const baseline = await page.evaluate((session) => {
      window.voiceFixtureIndex = session;
      return window.voiceProbe.events.length;
    }, session);
    phase = `session ${session + 1}: connect`;
    await page
      .getByRole("button", { name: "Start voice input", exact: true })
      .click();
    await waitStatus("Listening…");
    await page
      .getByRole("button", { name: "Mute microphone", exact: true })
      .click();
    assert.equal(
      await page.evaluate(
        () => window.voiceProbe.streams.at(-1).getAudioTracks()[0].enabled,
      ),
      false,
    );
    await page
      .getByRole("button", { name: "Unmute microphone", exact: true })
      .click();
    assert.equal(
      await page.evaluate(
        () => window.voiceProbe.streams.at(-1).getAudioTracks()[0].enabled,
      ),
      true,
    );
    phase = `session ${session + 1}: transcript and tool`;
    if (live) {
      await page.evaluate(() => window.playVoiceFixture());
      await waitFor(
        (baseline) =>
          window.voiceProbe.events
            .slice(baseline)
            .some(
              (event) =>
                event.type ===
                "conversation.item.input_audio_transcription.completed",
            ),
        baseline,
        60_000,
      );
      await waitFor(
        (baseline) =>
          window.voiceProbe.events
            .slice(baseline)
            .some(
              (event) => event.type === "response.function_call_arguments.done",
            ),
        baseline,
        60_000,
      );
      await waitFor(
        async () => {
          const bootstrap = await window.moleculeDesktop.bootstrap();
          const response = await fetch(
            `${bootstrap.apiUrl}/api/projects/${bootstrap.settings.lastProjectId}`,
          );
          const result = await response.json();
          return [
            "AWAITING_APPROVAL",
            "NEEDS_CLARIFICATION",
            "NEEDS_HUMAN",
          ].includes(result.project.state);
        },
        null,
        60_000,
      );
      phase = `session ${session + 1}: playback completion`;
      await waitFor(
        (baseline) =>
          window.voiceProbe.events
            .slice(baseline)
            .some((event) => event.type === "output_audio_buffer.stopped"),
        baseline,
        60_000,
      );
      await waitStatus("Listening…");
      const bootstrap = await page.evaluate(() =>
        window.moleculeDesktop.bootstrap(),
      );
      const result = await fetch(
        `${address}/api/projects/${bootstrap.settings.lastProjectId}`,
      ).then((response) => response.json());
      assert.ok(
        result.project.intent,
        "Voice must reach the authoritative intent compiler",
      );
      assert.ok(
        ["AWAITING_APPROVAL", "NEEDS_CLARIFICATION", "NEEDS_HUMAN"].includes(
          result.project.state,
        ),
      );
      summaries.push({
        transcript: await page
          .locator(".transcript:not(.assistant) p")
          .last()
          .textContent(),
        status: await status(),
        state: result.project.state,
        plan: result.project.activePlan?.status ?? null,
        revision: result.project.revision,
        playbackCompleted: true,
      });
    } else {
      const item = `utterance-${session}`;
      const response = `response-${session}`;
      const transcript =
        session === 0
          ? "Make 200 black cotton hoodies with embroidery by 2026-12-31 under $7000 CAD."
          : "Show my project status.";
      await emit({ type: "input_audio_buffer.speech_started", item_id: item });
      await waitStatus("Hearing you…");
      await emit({ type: "input_audio_buffer.speech_stopped", item_id: item });
      await waitStatus("Finishing transcript…");
      await emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: item,
        transcript,
      });
      await waitStatus("Thinking…");
      await emit({ type: "response.created", response: { id: response } });
      const name = session === 0 ? "start_project" : "get_project_status";
      await emit({
        type: "response.function_call_arguments.done",
        response_id: response,
        call_id: `verify-${session}`,
        name,
        arguments: JSON.stringify(session === 0 ? { intent: transcript } : {}),
      });
      await emit({
        type: "response.done",
        response: { id: response, status: "completed" },
      });
      await waitFor(
        (callId) =>
          window.voiceProbe.messages.some(
            (event) =>
              event.item?.call_id === callId &&
              event.item.type === "function_call_output",
          ),
        `verify-${session}`,
      );
      const result = await page.evaluate(
        (callId) =>
          JSON.parse(
            window.voiceProbe.messages.find(
              (event) => event.item?.call_id === callId,
            ).item.output,
          ),
        `verify-${session}`,
      );
      assert.ok(
        result.project.intent,
        "Voice must reach the authoritative intent compiler",
      );
      assert.ok(
        ["AWAITING_APPROVAL", "NEEDS_CLARIFICATION", "NEEDS_HUMAN"].includes(
          result.project.state,
        ),
      );
      const final = `final-${session}`;
      assert.equal(result.project.state, "AWAITING_APPROVAL");
      assert.equal(result.project.activePlan?.status, "VALID");
      if (session === 1) {
        const approvalCall = "unadvertised-voice-approval";
        const approvalResponse = "unadvertised-approval-response";
        await emit({
          type: "response.created",
          response: { id: approvalResponse },
        });
        await emit({
          type: "response.function_call_arguments.done",
          response_id: approvalResponse,
          call_id: approvalCall,
          name: "approve_action",
          arguments: JSON.stringify({
            planId: result.project.activePlan.planId,
            intentVersion: result.project.intentVersion,
          }),
        });
        await emit({
          type: "response.done",
          response: { id: approvalResponse, status: "completed" },
        });
        await waitFor(
          (callId) =>
            window.voiceProbe.messages.some(
              (event) =>
                event.item?.call_id === callId &&
                event.item.type === "function_call_output",
            ),
          approvalCall,
        );
        const denied = await page.evaluate(
          (callId) =>
            JSON.parse(
              window.voiceProbe.messages.find(
                (event) => event.item?.call_id === callId,
              ).item.output,
            ),
          approvalCall,
        );
        assert.equal(
          denied.error,
          "Review the plan and use Approve in the app.",
        );
        assert.equal(
          actionEvidence.some(
            (action) => action.command.name === "approve_action",
          ),
          false,
        );
        const unchanged = await fetch(
          `${address}/api/projects/${result.project.orderId}`,
        ).then((response) => response.json());
        assert.equal(unchanged.project.state, "AWAITING_APPROVAL");
        assert.equal(unchanged.project.executionReceipt, null);
      }
      await emit({ type: "response.created", response: { id: final } });
      await emit({
        type: "response.output_audio_transcript.delta",
        response_id: final,
        delta: "The solver has validated your plan.",
      });
      // Mock sessions have no remote audio track; completion remains text-first.
      await emit({
        type: "response.done",
        response: { id: final, status: "completed" },
      });
      await waitStatus("Listening…");
      summaries.push({
        session: session + 1,
        state: result.project.state,
        plan: result.project.activePlan.status,
      });
    }
    if (session === 0)
      await page.screenshot({
        path: join(artifacts, live ? "live-voice.png" : "voice-desktop.png"),
      });
    phase = `session ${session + 1}: cleanup`;
    if (!live && session === 8) {
      await page.getByRole("button", { name: "Hide Molecule" }).click();
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].show(),
      );
    } else if (!live && session === 9) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("Enable voice", { exact: true }).uncheck();
      await page.getByRole("button", { name: "Save settings" }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("Enable voice", { exact: true }).check();
      await page.getByRole("button", { name: "Save settings" }).click();
    } else {
      await page
        .getByRole("button", { name: "Stop voice input", exact: true })
        .click();
    }
    await waitFor(
      () =>
        window.voiceProbe.streams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        ) &&
        window.voiceProbe.contexts.every(
          (context) => context.state === "closed",
        ) &&
        window.voiceProbe.peers.every(
          (peer) => peer.connectionState === "closed",
        ),
    );
  }
  if (!live) {
    phase = "text failure preservation";
    await page.route("**/api/projects/*/actions", (route) =>
      route.fulfill({
        status: 503,
        json: { message: "Acceptance test backend unavailable" },
      }),
    );
    await page
      .locator("#intent")
      .fill("Keep this draft when the backend is unavailable.");
    await page.locator("#intent").press("Enter");
    await page.waitForSelector(".error");
    assert.equal(
      await page.locator("#intent").inputValue(),
      "Keep this draft when the backend is unavailable.",
    );
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(360, 680),
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.screenshot({
      path: join(artifacts, "voice-narrow-reduced-motion.png"),
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    phase = "permission denial";
    await desktop.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("desktop:permissions");
      ipcMain.handle("desktop:permissions", () => ({
        microphone: "denied",
        screen: "denied",
      }));
    });
    await page
      .getByRole("button", { name: "Start voice input", exact: true })
      .click();
    await waitStatus("Voice needs attention");
    assert.equal(
      await page
        .getByRole("button", { name: "Open microphone settings" })
        .count(),
      1,
    );
  }
  assert.deepEqual(pageErrors, []);
  const evidence = {
    mode: live
      ? "live OpenAI with synthetic speech"
      : "mock Realtime; real Chromium capture and AudioContext",
    solver: "real CP-SAT",
    externalCommerce: "mock; no approval or execution",
    osPermission: "simulated",
    audioOutput: "muted by test host",
    summaries,
    pageErrors,
  };
  await writeFile(
    join(artifacts, live ? "live-result.json" : "result.json"),
    JSON.stringify(evidence, null, 2),
  );
  await captureVoiceEvidence();
  console.log(JSON.stringify(evidence));
} catch (error) {
  console.error(`Voice acceptance failed at ${phase}: ${error.message}`);
  await captureVoiceEvidence().catch(() => {});
  if (desktop)
    console.error(
      "Audio evidence",
      await (
        await desktop.firstWindow()
      ).evaluate(async () => ({
        peak: window.voiceProbe?.peak,
        signals: window.voiceProbe?.signals,
        states: window.voiceProbe?.states,
        streams: window.voiceProbe?.streams.map((stream) =>
          stream.getTracks().map((track) => ({
            enabled: track.enabled,
            state: track.readyState,
          })),
        ),
        stats: await Promise.all(
          (window.voiceProbe?.peers ?? []).map(async (peer) =>
            peer.getStats
              ? [...(await peer.getStats()).values()]
                  .filter((stat) =>
                    ["media-source", "outbound-rtp"].includes(stat.type),
                  )
                  .map((stat) => ({
                    type: stat.type,
                    packetsSent: stat.packetsSent,
                    totalAudioEnergy: stat.totalAudioEnergy,
                  }))
              : peer.connectionState,
          ),
        ),
      })),
    );
  if (desktop && live)
    console.error(
      "Realtime event types",
      await (
        await desktop.firstWindow()
      ).evaluate(() =>
        window.voiceProbe?.events
          .filter((event) => !event.type.endsWith(".delta"))
          .map((event) => ({
            type: event.type,
            status: event.response?.status,
            code: event.error?.code,
          })),
      ),
    );
  if (desktop)
    await (
      await desktop.firstWindow()
    )
      .screenshot({ path: join(artifacts, "failure.png") })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  await desktop?.close();
  await app?.close();
  solver.kill();
  await rm(directory, { recursive: true, force: true });
}
