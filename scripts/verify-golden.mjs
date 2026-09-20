/**
 * Runs the golden-path brief through the complete pipeline — compile, candidate
 * discovery, merchant quotes, CP-SAT certification, approval and synthetic
 * Shopify execution — and fails on any deviation from the expected best-case run.
 *
 *   pnpm verify:golden                      # boots solver + orchestrator in-process
 *   MOLECULE_URL=http://127.0.0.1:3001 pnpm verify:golden   # against a running stack
 *
 * The in-process run pins the exact synthetic catalog outcome (capability ids,
 * cost, action count). Against a running stack the catalog may be the seeded
 * database, so only the outcome invariants are enforced unless GOLDEN_STRICT=true.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  GOLDEN_PATH_CORRECTION,
  GOLDEN_PATH_PROMPT,
  OrderSessionSnapshotSchema,
} from "../packages/contracts/src/index.ts";
import {
  GOLDEN_PATH_EXPECTATION,
  goldenPathDeviations,
  goldenPathEventDeviations,
} from "../services/orchestrator/src/demo/goldenPath.ts";

const withCorrection = process.env.GOLDEN_CORRECTION !== "false";
const strictPlan = process.env.GOLDEN_STRICT
  ? process.env.GOLDEN_STRICT === "true"
  : !process.env.MOLECULE_URL;
const started = Date.now();
const log = (label, detail = "") =>
  console.log(
    `[golden ${String(Date.now() - started).padStart(5)}ms] ${label}${detail ? ` ${detail}` : ""}`,
  );

let baseUrl = process.env.MOLECULE_URL;
let app;
let solver;
let directory;
try {
  if (!baseUrl) {
    directory = await mkdtemp(join(tmpdir(), "molecule-golden-"));
    const python =
      process.env.SOLVER_PYTHON ?? resolve("services/solver/.venv/bin/python");
    solver = spawn(
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
    const solverUrl = await new Promise((resolveUrl, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Solver did not start within 30 seconds")),
        30_000,
      );
      solver.once("error", reject);
      solver.once("exit", (code) =>
        reject(
          new Error(
            `Solver exited (${code}); install its Python 3.12 dependencies`,
          ),
        ),
      );
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
      STORAGE_MODE: "local",
      USE_MOCK_OPENAI: "true",
      DEMO_MODE: "true",
      BACKBOARD_MODE: "demo",
      SHOPIFY_MODE: "demo",
      REAL_EXECUTION_ENABLED: "false",
    });
    const { createApp } = await import("../services/orchestrator/src/index.ts");
    ({ app } = await createApp());
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    log("stack ready", `solver=${solverUrl} orchestrator=${baseUrl}`);
  } else {
    log(
      "using running orchestrator",
      `${baseUrl}${strictPlan ? "" : " (catalog-agnostic checks; GOLDEN_STRICT=true to pin)"}`,
    );
  }

  const request = async (method, path, body, actionId) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(actionId ? { "x-action-id": actionId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    assert.ok(
      response.ok,
      `${method} ${path} -> ${response.status} ${JSON.stringify(json)}`,
    );
    return json;
  };
  const snapshot = (value) => OrderSessionSnapshotSchema.parse(value);
  const expectClean = (issues, label) =>
    assert.deepEqual(issues, [], `${label} deviated from the golden path`);
  const deviations = (value, phase) =>
    goldenPathDeviations(value, phase, { strictPlan });

  const run = randomUUID().slice(0, 8);
  const message = {
    text: GOLDEN_PATH_PROMPT,
    locale: "en-CA",
    timeZone: process.env.GOLDEN_TIME_ZONE ?? "America/Toronto",
    assets: [],
  };

  const order = snapshot(
    await request("POST", "/api/orders", {}, `golden-${run}-create`),
  );
  log("order created", `${order.orderId} trace=${order.traceId}`);

  const planned = snapshot(
    await request(
      "POST",
      `/api/orders/${order.orderId}/messages`,
      message,
      `golden-${run}-brief`,
    ),
  );
  expectClean(deviations(planned, "planned"), "planning");
  const plan = planned.activePlan;
  log(
    "brief compiled",
    `intent v${planned.intentVersion}, ${planned.intent.ambiguityFlags.length} questions, deadline ${planned.intent.deadline}`,
  );
  log(
    "candidates + quotes",
    `${planned.candidates.length} candidates, ${planned.quotes.filter((q) => q.status === "CAN_ACCEPT").length} CAN_ACCEPT`,
  );
  log(
    "plan certified",
    `${plan.status} ${plan.currency} ${plan.totalCost} / ${planned.intent.budgetMax}, completes ${plan.estimatedCompletion}, risk ${plan.riskScore.toFixed(3)}`,
  );
  for (const node of plan.nodes)
    log(
      "  node",
      `${node.kind.padEnd(9)} ${node.capabilityId} @ ${node.merchantId}`,
    );

  const replayed = snapshot(
    await request(
      "POST",
      `/api/orders/${order.orderId}/messages`,
      message,
      `golden-${run}-brief`,
    ),
  );
  assert.equal(
    replayed.revision,
    planned.revision,
    "brief replay was not idempotent",
  );

  let current = planned;
  if (withCorrection) {
    current = snapshot(
      await request(
        "POST",
        `/api/orders/${order.orderId}/messages`,
        {
          ...message,
          text: GOLDEN_PATH_CORRECTION,
          correction: { kind: "constraint", text: GOLDEN_PATH_CORRECTION },
          expectedRevision: planned.revision,
        },
        `golden-${run}-correction`,
      ),
    );
    expectClean(deviations(current, "planned"), "correction");
    assert.equal(current.intentVersion, planned.intentVersion + 1);
    assert.equal(
      current.intent.hardConstraints.at(-1)?.constraintId,
      "no-polyester",
    );
    log(
      "correction applied",
      `intent v${current.intentVersion}, plan ${current.activePlan.planId} still ${current.activePlan.status} at ${current.activePlan.totalCost}`,
    );
  }

  const approval = {
    planId: current.activePlan.planId,
    intentVersion: current.intentVersion,
  };
  const completed = snapshot(
    await request("POST", `/api/orders/${order.orderId}/approve`, approval),
  );
  expectClean(deviations(completed, "completed"), "execution");
  const receipt = completed.executionReceipt;
  log(
    "executed",
    `${completed.state}; ${receipt.actions.length} actions, product ${receipt.compositeProduct.productGid}, ${receipt.supplierJobs.length} supplier jobs, order ${receipt.customerOrder.draftOrderGid ?? receipt.customerOrder.orderGid}`,
  );
  const again = snapshot(
    await request("POST", `/api/orders/${order.orderId}/approve`, approval),
  );
  assert.deepEqual(again.executionReceipt, receipt, "approval replay diverged");

  const events = [];
  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/api/orders/${order.orderId}/events`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (!data) continue;
        const event = JSON.parse(data);
        events.push(event);
        if (event.eventType === "order.completed") break outer;
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  expectClean(goldenPathEventDeviations(events), "event log");
  assert.ok(
    events.every((event) => event.traceId === order.traceId),
    "events crossed trace ids",
  );
  log(
    "event log",
    `${events.length} events on trace ${order.traceId}; ${GOLDEN_PATH_EXPECTATION.eventOrder.length} milestones in order`,
  );
  log("GOLDEN PATH OK");
} finally {
  await app?.close();
  solver?.kill();
  if (directory) await rm(directory, { recursive: true, force: true });
}
