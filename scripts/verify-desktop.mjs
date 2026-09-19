import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DesktopResultSchema } from "../packages/contracts/src/index.ts";
import { createApp } from "../services/orchestrator/src/index.ts";

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
  const date = new Date(Date.now() + 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const planned = await command(
    "start_project",
    {
      intent: `Make 200 black hoodies with embroidery by ${date} under $7000 CAD`,
    },
    "verify-start",
  );
  assert.equal(planned.project.activePlan?.status, "VALID");
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
  const { contextId } = upload.json();
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
  const supplier = approved.project.activePlan.nodes.find(
    (node) => node.kind === "TRANSFORM",
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
