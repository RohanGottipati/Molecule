import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../services/orchestrator/src/index.ts";
import { consumeEvents } from "../apps/desktop/src/renderer/services/events.ts";

const { ContextReceiptSchema, DesktopResultSchema, MarketplaceSnapshotSchema } =
  createRequire(new URL("../apps/desktop/package.json", import.meta.url))(
    "@molecule/contracts",
  );

const scenario = process.env.DESKTOP_VERIFY_SCENARIO ?? "hoodie";
assert.ok(
  ["hoodie", "kit"].includes(scenario),
  "Choose hoodie or kit for DESKTOP_VERIFY_SCENARIO",
);
const directory = await mkdtemp(join(tmpdir(), "molecule-desktop-verify-"));
const python =
  process.env.SOLVER_PYTHON ?? resolve("services/solver/.venv/bin/python");
const solver = spawn(
  python,
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
  { stdio: ["ignore", "pipe", "pipe"] },
);
let app;
try {
  const solverUrl = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Solver did not start within 30 seconds")),
      30_000,
    );
    solver.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    solver.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Solver exited (${code}); install its Python 3.12 dependencies`,
        ),
      );
    });
    solver.stderr.on("data", (chunk) => {
      const url = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) {
        clearTimeout(timer);
        resolveUrl(url);
      }
    });
  });
  Object.assign(process.env, {
    SOLVER_URL: solverUrl,
    DATA_DIR: directory,
    USE_MOCK_OPENAI: "true",
    DEMO_MODE: "true",
    REAL_EXECUTION_ENABLED: "false",
  });
  ({ app } = await createApp());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const providerResponse = await app.inject("/api/marketplace");
  let providerStatus = "unavailable endpoint";
  if (providerResponse.statusCode === 200) {
    const marketplace = MarketplaceSnapshotSchema.parse(
      providerResponse.json(),
    );
    providerStatus = marketplace.mode;
    assert.ok(marketplace.providers.length > 0);
  } else {
    assert.equal(providerResponse.statusCode, 404);
  }
  async function post(path, payload) {
    const response = await app.inject({ method: "POST", url: path, payload });
    assert.ok(response.statusCode < 300, `${path}: ${response.statusCode}`);
    return response.json();
  }
  const create = { source: "desktop", actionId: "verify-create" };
  const initial = DesktopResultSchema.parse(
    await post("/api/projects", create),
  );
  const id = initial.project.orderId;
  assert.equal(
    DesktopResultSchema.parse(await post("/api/projects", create)).project
      .orderId,
    id,
  );
  async function command(name, args, actionId) {
    return DesktopResultSchema.parse(
      await post(`/api/projects/${id}/actions`, {
        actionId,
        command: { name, args },
      }),
    );
  }
  const days =
    scenario === "kit" ? (5 - new Date().getUTCDay() + 7) % 7 || 7 : 30;
  const date = new Date(Date.now() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const planned = await command(
    "start_project",
    {
      intent:
        scenario === "kit"
          ? `Make 200 premium black onboarding kits by next Friday (${date}) under CAD 7000. No leather. Each kit needs a black hoodie with embroidered logo, a bottle engraved with the recipient's name, vegan snacks, individual packaging and fulfillment.`
          : `Make 200 black hoodies with embroidery by ${date} under $7000 CAD`,
    },
    "verify-start",
  );
  assert.equal(planned.project.activePlan?.status, "VALID");
  if (scenario === "kit") {
    assert.deepEqual(
      planned.project.intent.desiredOutputs
        .map((output) => output.outputId)
        .sort(),
      ["bottle", "hoodie", "snacks"],
    );
    assert.ok(
      planned.project.activePlan.nodes.length >= 7,
      "The complete kit needs goods, branding, assembly and fulfillment",
    );
    assert.ok(planned.project.activePlan.totalCost <= 7000);
    assert.ok(
      Date.parse(planned.project.activePlan.estimatedCompletion) <=
        Date.parse(planned.project.intent.deadline),
    );
  }
  const upload = await app.inject({
    method: "POST",
    url: `/api/projects/${id}/context`,
    headers: {
      "content-type": "application/octet-stream",
      "x-file-type": "text/plain",
      "x-file-name": "brief.txt",
      "x-action-id": "verify-upload",
    },
    payload: Buffer.from("Use this customer brief for the hoodie."),
  });
  assert.equal(upload.statusCode, 200);
  const { contextId } = ContextReceiptSchema.parse(upload.json());
  const repeatedUpload = await app.inject({
    method: "POST",
    url: `/api/projects/${id}/context`,
    headers: {
      "content-type": "application/octet-stream",
      "x-file-type": "text/plain",
      "x-file-name": "brief.txt",
      "x-action-id": "verify-upload",
    },
    payload: Buffer.from("Use this customer brief for the hoodie."),
  });
  assert.equal(
    ContextReceiptSchema.parse(repeatedUpload.json()).contextId,
    contextId,
  );
  const attached = await command(
    "attach_context",
    { contextId },
    "verify-attach",
  );
  assert.equal(attached.contexts.length, 1);
  const args = {
    constraint: {
      field: "material",
      operator: "not_contains",
      value: "polyester",
      hard: true,
    },
  };
  const changed = await command("add_constraint", args, "verify-interrupt");
  assert.equal(
    changed.project.intentVersion,
    planned.project.intentVersion + 1,
  );
  assert.equal(changed.project.activePlan?.status, "VALID");
  assert.ok(
    changed.project.intent?.hardConstraints.some(
      (item) => item.value === "polyester",
    ),
  );
  assert.equal(
    (await command("add_constraint", args, "verify-interrupt")).project
      .revision,
    changed.project.revision,
  );
  const approved = await command(
    "approve_action",
    {
      planId: changed.project.activePlan.planId,
      intentVersion: changed.project.intentVersion,
    },
    "verify-approve",
  );
  assert.equal(approved.project.state, "COMPLETED");
  const supplier = approved.project.activePlan.nodes.find((node) =>
    /embroider/i.test(
      approved.project.candidates.find(
        (candidate) => candidate.capabilityId === node.capabilityId,
      )?.capability.name ?? "",
    ),
  );
  assert.ok(supplier);
  const chaos = {
    scenario: "supplier_offline",
    orderId: id,
    merchantId: supplier.merchantId,
    actionId: "verify-chaos",
  };
  const recovered = await post("/api/chaos", chaos);
  assert.equal(recovered.state, "COMPLETED");
  assert.ok(
    !recovered.activePlan.nodes.some(
      (node) => node.merchantId === supplier.merchantId,
    ),
  );
  assert.ok(recovered.activePlan.totalCost <= recovered.intent.budgetMax);
  assert.ok(
    Date.parse(recovered.activePlan.estimatedCompletion) <=
      Date.parse(recovered.intent.deadline),
  );
  assert.equal((await post("/api/chaos", chaos)).revision, recovered.revision);
  const persisted = JSON.parse(
    await readFile(join(directory, "state.json"), "utf8"),
  );
  const events = persisted.events.map((item) => item.event);
  assert.ok(
    events.some((event) => event.eventType === "shopify.product.created"),
  );
  assert.equal(
    events.filter((event) => event.eventType === "supplier.offline").length,
    1,
  );
  const recovery = events.find(
    (event) => event.eventType === "recovery.completed",
  );
  assert.ok(recovery);
  assert.equal(recovery.payload.approvalRequired, false);
  assert.equal(recovery.payload.deadlinePreserved, true);
  assert.equal(
    recovery.payload.costDelta,
    Math.round(
      (recovered.activePlan.totalCost - approved.project.activePlan.totalCost) *
        100,
    ) / 100,
  );
  const refreshed = await command("get_project_status", {}, "verify-status");
  assert.equal(
    refreshed.project.activePlan.planId,
    recovered.activePlan.planId,
  );
  async function replay(cursor = 0) {
    const controller = new AbortController();
    const frames = [];
    let ready = false;
    const response = await fetch(`${address}/api/orders/${id}/events`, {
      headers: { "Last-Event-ID": String(cursor) },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    assert.ok(response.ok && response.body);
    await consumeEvents(
      response.body,
      (frame) => {
        if (frame.event === "molecule") frames.push(frame);
        if (frame.event === "ready") {
          ready = true;
          controller.abort();
        }
      },
      controller.signal,
    );
    assert.ok(ready, "SSE must mark the replay/live boundary");
    return frames;
  }
  const replayed = await replay();
  assert.ok(replayed.length > 1);
  assert.equal(
    new Set(replayed.map((frame) => frame.id)).size,
    replayed.length,
  );
  const last = replayed.at(-1);
  assert.ok(last.id > 0);
  assert.deepEqual(
    (await replay(last.id - 1)).map((frame) => frame.id),
    [last.id],
  );
  assert.equal((await replay(last.id)).length, 0);
  const disposable = DesktopResultSchema.parse(
    await post("/api/projects", {
      source: "desktop",
      actionId: "verify-cancel-create",
    }),
  );
  const cancelPayload = {
    actionId: "verify-cancel",
    command: { name: "cancel_project", args: {} },
  };
  const cancelled = DesktopResultSchema.parse(
    await post(
      `/api/projects/${disposable.project.orderId}/actions`,
      cancelPayload,
    ),
  );
  assert.equal(cancelled.project.state, "CANCELLED");
  assert.equal(
    DesktopResultSchema.parse(
      await post(
        `/api/projects/${disposable.project.orderId}/actions`,
        cancelPayload,
      ),
    ).project.revision,
    cancelled.project.revision,
  );
  await app.close();
  ({ app } = await createApp());
  const restarted = DesktopResultSchema.parse(
    (await app.inject(`/api/projects/${id}`)).json(),
  );
  assert.equal(
    restarted.project.activePlan?.planId,
    recovered.activePlan.planId,
  );
  assert.equal(restarted.contexts.length, 1);
  console.log(
    JSON.stringify({
      result: "passed",
      solver: "real CP-SAT",
      providers: "mocks",
      providerStatus,
      scenario,
      replay: "cursor restored without duplicate events",
      cancellation: "idempotent",
      recoveryCostDelta:
        recovered.activePlan.totalCost - approved.project.activePlan.totalCost,
      restart: "restored",
    }),
  );
} finally {
  await app?.close();
  solver.kill();
  await rm(directory, { recursive: true, force: true });
}
