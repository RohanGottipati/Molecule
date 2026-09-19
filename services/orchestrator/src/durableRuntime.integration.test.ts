import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ContextReceiptSchema,
  DesktopResultSchema,
  MarketplaceSnapshotSchema,
  OrderSessionSnapshotSchema,
} from "@molecule/contracts";
import {
  closePool,
  getPool,
  migrate,
  resetDemoData,
  seedDemo,
} from "@molecule/db";
import { createApp } from "./index.js";
import { PostgresStore } from "./PostgresStore.js";
import { createOrderSession } from "./session/OrderSession.js";
import { makeEvent } from "./events/EventStore.js";
import { ActionLedger } from "./ActionLedger.js";

const database = process.env.ORCHESTRATOR_TEST_DATABASE_URL;
const schema = `orchestrator_test_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!database)("durable runtime acceptance", () => {
  let app: FastifyInstance;
  let solver: ChildProcess;
  const store = new PostgresStore();

  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    const existing = await getPool().query<{ relation: string | null }>(
      "select to_regclass('public.merchants') as relation",
    );
    if (existing.rows[0]?.relation)
      throw new Error(
        "ORCHESTRATOR_TEST_DATABASE_URL must point to an empty test database",
      );
    await getPool().query(`create schema ${schema}`);
    await closePool();
    const scoped = new URL(database!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    Object.assign(process.env, {
      DATABASE_URL: scoped.toString(),
      STORAGE_MODE: "postgres",
      DEMO_MODE: "true",
      USE_MOCK_OPENAI: "true",
      BACKBOARD_MODE: "demo",
      SHOPIFY_MODE: "demo",
      REAL_EXECUTION_ENABLED: "false",
    });
    await migrate();
    await seedDemo();
    await resetDemoData();
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    solver = spawn(
      `${root}/services/solver/.venv/bin/python`,
      [
        "-m",
        "uvicorn",
        "app.main:app",
        "--app-dir",
        `${root}/services/solver`,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    process.env.SOLVER_URL = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Solver startup timed out")),
        20000,
      );
      solver.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      solver.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Solver exited: ${code}`));
      });
      solver.stderr!.on("data", (data: Buffer) => {
        const url = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      });
    });
    ({ app } = await createApp());
  }, 30000);

  afterAll(async () => {
    await app?.close();
    solver?.kill();
    process.env.DATABASE_URL = database;
    await getPool().query(`drop schema if exists ${schema} cascade`);
    await closePool();
  });

  async function post(url: string, payload: object, actionId = randomUUID()) {
    const response = await app.inject({
      method: "POST",
      url,
      payload,
      headers: { "x-action-id": actionId },
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json();
  }

  it("rolls back events with failed revisions and claims actions across workers", async () => {
    const session = createOrderSession();
    await store.create(session);
    const event = makeEvent({
      traceId: session.traceId,
      orderId: session.orderId,
      eventType: "test.atomic",
      source: "orchestrator",
    });
    await expect(
      store.saveWithEvent({ ...session, revision: 1 }, 99, event),
    ).rejects.toThrow("superseded");
    expect(await store.list(session.orderId, 0)).toEqual([]);
    const saved = await store.saveWithEvent(
      { ...session, revision: 1 },
      0,
      event,
    );
    expect(saved.eventCursor).toBeGreaterThan(0);
    let executions = 0;
    const run = () =>
      new ActionLedger(new PostgresStore()).run(
        `claim:${randomUUID()}`,
        {},
        String,
        async () => String(++executions),
      );
    await run();
    const key = `claim:${randomUUID()}`;
    const operation = async () => String(++executions);
    const concurrent = await Promise.allSettled([
      new ActionLedger(store).run(key, {}, String, operation),
      new ActionLedger(new PostgresStore()).run(key, {}, String, operation),
    ]);
    expect(concurrent.some((result) => result.status === "fulfilled")).toBe(
      true,
    );
    expect(executions).toBe(2);
    expect(await new ActionLedger(store).run(key, {}, String, operation)).toBe(
      "2",
    );
    expect(executions).toBe(2);
  });

  it("compiles the kit, corrects, executes, replaces a failed supplier and replays after restart", async () => {
    const initial = OrderSessionSnapshotSchema.parse(
      await post("/api/orders", {}),
    );
    const id = initial.orderId;
    const message = {
      text: "200 premium black onboarding kits by next Friday under CAD 7000. No leather. Hoodie logo embroidery, named engraved bottles, vegan snacks, individual packaging and fulfillment.",
    };
    const planned = OrderSessionSnapshotSchema.parse(
      await post(`/api/orders/${id}/messages`, message, "initial"),
    );
    expect(planned.activePlan?.status, JSON.stringify(planned.quotes)).toBe(
      "VALID",
    );
    expect(planned.activePlan?.nodes).toHaveLength(7);
    const repeated = OrderSessionSnapshotSchema.parse(
      await post(`/api/orders/${id}/messages`, message, "initial"),
    );
    expect(repeated.revision).toBe(planned.revision);
    const upload = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/context`,
      headers: {
        "content-type": "application/octet-stream",
        "x-file-type": "text/plain",
        "x-file-name": "brief.txt",
        "x-action-id": "context",
      },
      payload: Buffer.from("Customer-provided branding brief"),
    });
    expect(upload.statusCode).toBe(200);
    const context = ContextReceiptSchema.parse(upload.json());
    await post(`/api/projects/${id}/actions`, {
      actionId: "attach",
      command: {
        name: "attach_context",
        args: { contextId: context.contextId },
      },
    });
    const corrected = OrderSessionSnapshotSchema.parse(
      await post(`/api/orders/${id}/messages`, { text: "No polyester." }),
    );
    expect(corrected.intentVersion).toBe(2);
    expect(corrected.activePlan?.status, JSON.stringify(corrected.quotes)).toBe(
      "VALID",
    );
    expect(corrected.intent?.hardConstraints).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "polyester" })]),
    );
    expect(corrected.intent?.assets).toHaveLength(1);
    const stale = await app.inject({
      method: "POST",
      url: `/api/orders/${id}/approve`,
      payload: { planId: planned.activePlan!.planId, intentVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const approval = { planId: corrected.activePlan!.planId, intentVersion: 2 };
    const approved = OrderSessionSnapshotSchema.parse(
      await post(`/api/orders/${id}/approve`, approval),
    );
    expect(approved.state, JSON.stringify(approved.executionReceipt)).toBe(
      "COMPLETED",
    );
    expect(approved.executionReceipt?.supplierJobs).toHaveLength(7);
    expect(
      OrderSessionSnapshotSchema.parse(
        await post(`/api/orders/${id}/approve`, approval),
      ).revision,
    ).toBe(approved.revision);
    const supplier = approved.activePlan!.nodes.find((node) =>
      node.capabilityId.includes("embroidery"),
    )!;
    const chaos = {
      scenario: "supplier_offline",
      orderId: id,
      merchantId: supplier.merchantId,
      actionId: "failure",
    };
    const recovered = OrderSessionSnapshotSchema.parse(
      await post("/api/chaos", chaos),
    );
    expect(recovered.state, JSON.stringify(recovered)).toBe("COMPLETED");
    expect(recovered.activePlan?.nodes).toHaveLength(7);
    expect(
      recovered.activePlan?.nodes.every(
        (node) => node.merchantId !== supplier.merchantId,
      ),
    ).toBe(true);
    expect(recovered.activePlan!.totalCost).toBeLessThanOrEqual(7000);
    expect(
      Date.parse(recovered.activePlan!.estimatedCompletion!),
    ).toBeLessThanOrEqual(Date.parse(recovered.intent!.deadline!));
    expect(
      OrderSessionSnapshotSchema.parse(await post("/api/chaos", chaos))
        .revision,
    ).toBe(recovered.revision);
    const before = await store.list(id, 0);
    const recovery = before.find(
      ({ event }) => event.eventType === "recovery.completed",
    )!;
    expect(recovery.event.payload.costDelta).toBe(120);
    const snapshot = MarketplaceSnapshotSchema.parse(
      (await app.inject("/api/marketplace")).json(),
    );
    expect(
      snapshot.merchants.find(
        (merchant) => merchant.merchantId === supplier.merchantId,
      )?.status,
    ).toBe("offline");
    expect(snapshot.metrics.reservationCount).toBe(7);
    expect(
      snapshot.providers.find(({ name }) => name === "shopify")?.mode,
    ).toBe("demo");
    expect(snapshot.merchants.some(({ memories }) => memories.length > 0)).toBe(
      true,
    );
    await app.close();
    ({ app } = await createApp());
    const restored = DesktopResultSchema.parse(
      (await app.inject(`/api/projects/${id}`)).json(),
    );
    expect(restored.project.activePlan?.planId).toBe(
      recovered.activePlan?.planId,
    );
    expect(restored.contexts).toHaveLength(1);
    expect(
      (
        await getPool().query<{ content: Buffer }>(
          "select content from order_contexts where context_id=$1",
          [context.contextId],
        )
      ).rows[0]?.content.toString(),
    ).toBe("Customer-provided branding brief");
    expect((await store.list(id, 0)).map(({ event }) => event.eventId)).toEqual(
      before.map(({ event }) => event.eventId),
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const last = before.at(-1)!.cursor;
    const controller = new AbortController();
    const stream = await fetch(`${address}/api/orders/${id}/events`, {
      headers: { "last-event-id": String(before.at(-2)!.cursor) },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    });
    const reader = stream.body!.getReader();
    let text = "";
    while (!text.includes("event: ready")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    expect(text.match(/^id: \d+/gm)).toEqual([`id: ${last}`]);
    const replacement = recovered.activePlan!.nodes.find((node) =>
      node.capabilityId.includes("embroidery"),
    )!;
    const exhausted = OrderSessionSnapshotSchema.parse(
      await post("/api/chaos", {
        ...chaos,
        merchantId: replacement.merchantId,
        actionId: "exhausted",
      }),
    );
    expect(exhausted.state).toBe("NEEDS_HUMAN");
    expect(exhausted.activePlan?.status).toBe("UNSAT");
    await post("/api/demo/reset", {});
    const reset = MarketplaceSnapshotSchema.parse(
      (await app.inject("/api/marketplace")).json(),
    );
    expect(reset.merchants.every(({ status }) => status === "online")).toBe(
      true,
    );
    expect(reset.metrics.reservationCount).toBe(0);
  }, 30000);
});
