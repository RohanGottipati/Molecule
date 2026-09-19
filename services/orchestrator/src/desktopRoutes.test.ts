import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopResultSchema,
  ProductionPlanSchema,
  type SolverInput,
} from "@molecule/contracts";
import { MockOpenAIAdapter } from "@molecule/openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ActionLedger } from "./ActionLedger.js";
import { ConfigSchema } from "./config.js";
import { makeEvent } from "./events/EventStore.js";
import { LocalStore } from "./LocalStore.js";
import { MockMerchantAgentClient } from "./mocks/MockMerchantAgentClient.js";
import { MockRealityClient } from "./mocks/MockRealityClient.js";
import { MockShopifyClient } from "./mocks/MockShopifyClient.js";
import { buildServer } from "./server.js";
import { createOrderSession } from "./session/OrderSession.js";
import { Orchestrator } from "./workflow/Orchestrator.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true });
});
async function fixture(directory?: string) {
  const store = new LocalStore(directory);
  await store.load();
  const openai = new MockOpenAIAdapter();
  const solver = {
    solve: vi.fn(async (input: SolverInput) =>
      ProductionPlanSchema.parse({
        planId: `unsat-${input.generation}`,
        orderId: input.orderId,
        intentVersion: input.intent.version,
        status: "UNSAT",
        nodes: [],
        edges: [],
        totalCost: 0,
        currency: input.intent.currency,
        riskScore: 1,
        constraintResults: [],
        unsatRelaxations: [],
      }),
    ),
  };
  const orchestrator = new Orchestrator({
    sessions: store,
    events: store,
    openai,
    solver,
    reality: new MockRealityClient(),
    merchantAgents: new MockMerchantAgentClient(),
    shopify: new MockShopifyClient(),
  });
  const app = await buildServer({
    config: ConfigSchema.parse({ DEMO_MODE: "true" }),
    sessions: store,
    events: store,
    desktopStore: store,
    orchestrator,
    solver,
    openai,
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { actionId: "create-project", source: "desktop" },
  });
  expect(response.statusCode).toBe(201);
  const { project } = DesktopResultSchema.parse(response.json());
  return { app, store, project, orchestrator, solver, openai };
}

describe("desktop backend integration", () => {
  it("creates once across retries and restart, without recreating a realtime session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "molecule-desktop-"));
    directories.push(directory);
    const first = await fixture(directory);
    await first.app.close();
    const second = await fixture(directory);
    try {
      expect(second.project.orderId).toBe(first.project.orderId);
    } finally {
      await second.app.close();
    }
  });
  it("coalesces concurrent actions and rejects ambiguous or conflicting retries", async () => {
    const store = new LocalStore();
    const ledger = new ActionLedger(store);
    const action = vi.fn(async () => ({ value: 2 }));
    const parse = z.object({ value: z.number() }).parse;
    await Promise.all([
      ledger.run("once", { input: 1 }, parse, action),
      ledger.run("once", { input: 1 }, parse, action),
    ]);
    expect(action).toHaveBeenCalledTimes(1);
    await expect(
      new ActionLedger(store).run("once", { input: 1 }, parse, action),
    ).resolves.toEqual({ value: 2 });
    await expect(
      ledger.run("once", { input: 2 }, parse, action),
    ).rejects.toThrow("different arguments");
    await store.saveReceipt({
      key: "unknown",
      fingerprint: (await store.getReceipt("once"))!.fingerprint,
      state: "pending",
    });
    await expect(
      new ActionLedger(store).run("unknown", { input: 1 }, parse, action),
    ).rejects.toThrow("outcome unknown");
    expect(action).toHaveBeenCalledTimes(1);
  });
  it("uploads and attaches context once, validates signatures, and compiles real constraint mutations", async () => {
    const { app, project, store } = await fixture();
    try {
      const upload = {
        method: "POST" as const,
        url: `/api/projects/${project.orderId}/context`,
        headers: {
          "content-type": "application/octet-stream",
          "x-file-type": "text/plain",
          "x-file-name": "brief.txt",
          "x-action-id": "upload",
        },
        payload: Buffer.from("Customer supplied brief"),
      };
      const response = await app.inject(upload);
      expect(response.statusCode).toBe(200);
      const context = z.object({ contextId: z.uuid() }).parse(response.json());
      expect((await app.inject(upload)).json()).toEqual(response.json());
      expect(store.contexts(project.orderId)).toHaveLength(1);
      const invalidImage = await app.inject({
        ...upload,
        headers: {
          ...upload.headers,
          "x-file-type": "image/png",
          "x-file-name": "logo.png",
          "x-action-id": "invalid",
        },
      });
      expect(invalidImage.statusCode).toBe(400);
      const command = (name: string, args: object, actionId: string) =>
        app.inject({
          method: "POST",
          url: `/api/projects/${project.orderId}/actions`,
          payload: { actionId, command: { name, args } },
        });
      expect(
        (await command("attach_context", context, "attach")).statusCode,
      ).toBe(200);
      expect(
        (
          await command(
            "start_project",
            { intent: "Make 20 hoodies by 2026-10-01 under $1000 CAD" },
            "start",
          )
        ).statusCode,
      ).toBe(200);
      const constraint = {
        field: "material",
        operator: "not_contains",
        value: "polyester",
        hard: true,
      };
      const changed = DesktopResultSchema.parse(
        (await command("add_constraint", { constraint }, "correction")).json(),
      );
      expect(changed.project.intent?.hardConstraints).toContainEqual(
        expect.objectContaining({
          constraintId: "correction",
          field: "material",
          operator: "not_contains",
          value: "polyester",
        }),
      );
      expect(changed.contexts).toHaveLength(1);
      const replayed = DesktopResultSchema.parse(
        (await command("add_constraint", { constraint }, "correction")).json(),
      );
      expect(replayed.project.revision).toBe(changed.project.revision);
      expect(
        (await store.list(project.orderId, 0)).filter(
          ({ event }) => event.eventType === "constraint.added",
        ),
      ).toHaveLength(1);
      expect(
        (
          await command(
            "remove_constraint",
            { constraintId: "correction" },
            "remove",
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await store.get(project.orderId))?.intent?.hardConstraints,
      ).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
  it("queues an early structured interruption and prevents a cancelled compile from resurrecting", async () => {
    const { app, project, orchestrator, openai, store } = await fixture();
    try {
      let release: () => void = () => undefined;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const compile = openai.compileIntent.bind(openai);
      vi.spyOn(openai, "compileIntent").mockImplementation(async (input) => {
        await barrier;
        return compile(input);
      });
      const initial = orchestrator.submitMessage({
        orderId: project.orderId,
        traceId: project.traceId,
        text: "Make 20 hoodies by 2026-10-01 CAD",
        locale: "en-CA",
        timeZone: "UTC",
        requestedAt: new Date().toISOString(),
        assets: [],
      });
      const correction = orchestrator.revise(
        project.orderId,
        {
          name: "add_constraint",
          args: {
            constraint: {
              field: "material",
              operator: "not_contains",
              value: "polyester",
              hard: true,
            },
          },
        },
        "early",
      );
      release();
      await initial;
      expect((await correction).intent?.hardConstraints).toContainEqual(
        expect.objectContaining({ constraintId: "early" }),
      );
      const fresh = createOrderSession();
      await store.create(fresh);
      let finish: () => void = () => undefined;
      const pause = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.spyOn(openai, "compileIntent").mockImplementation(async (input) => {
        await pause;
        return compile(input);
      });
      const pending = orchestrator.submitMessage({
        orderId: fresh.orderId,
        traceId: fresh.traceId,
        text: "Make 20 hoodies by 2026-10-01 CAD",
        locale: "en-CA",
        timeZone: "UTC",
        requestedAt: new Date().toISOString(),
        assets: [],
      });
      await vi.waitFor(async () =>
        expect((await store.get(fresh.orderId))?.state).toBe(
          "COMPILING_INTENT",
        ),
      );
      await orchestrator.cancel(fresh.orderId);
      finish();
      expect((await pending).state).toBe("CANCELLED");
    } finally {
      await app.close();
    }
  });
  it("replays SSE cursors, delivers later events, and rejects untrusted browser origins", async () => {
    const { app, project, store } = await fixture();
    const controller = new AbortController();
    try {
      expect(
        (
          await app.inject({
            url: "/api/desktop/config",
            headers: { origin: "https://untrusted.example" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/desktop/realtime-session",
            payload: { projectId: project.orderId },
          })
        ).statusCode,
      ).toBe(503);
      const replay = await store.append(
        makeEvent({
          traceId: project.traceId,
          orderId: project.orderId,
          eventType: "context.attached",
          source: "ui",
          payload: {},
        }),
      );
      const url = await app.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(
        `${url}/api/orders/${project.orderId}/events`,
        {
          headers: {
            "Last-Event-ID": String(replay.cursor - 1),
            Origin: "app://molecule",
          },
          signal: controller.signal,
        },
      );
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "app://molecule",
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let data = "";
      while (!data.includes("event: ready"))
        data += decoder.decode((await reader.read()).value);
      expect(data).toContain(`id: ${replay.cursor}`);
      expect(data).not.toContain("order.created");
      const next = await store.append(
        makeEvent({
          traceId: project.traceId,
          orderId: project.orderId,
          eventType: "supplier.offline",
          source: "orchestrator",
          payload: {},
        }),
      );
      const live = decoder.decode((await reader.read()).value);
      expect(live).toContain(`id: ${next.cursor}`);
      await reader.cancel();
    } finally {
      controller.abort();
      await app.close();
    }
  });
});
