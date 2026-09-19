import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ActionStatusSchema,
  MessageHistorySchema,
  OrderSessionSnapshotSchema,
  ProductionPlanSchema,
  ProjectListSchema,
  type CompileIntentResult,
  type SolverInput,
} from "@molecule/contracts";
import { MockOpenAIAdapter } from "@molecule/openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionLedger } from "./ActionLedger.js";
import { ConfigSchema } from "./config.js";
import { ExecutionInterruptedError } from "./clients/ExecutionInterruptedError.js";
import { makeEvent } from "./events/EventStore.js";
import { LocalStore } from "./LocalStore.js";
import { readMessageHistory } from "./messageHistory.js";
import { MockMerchantAgentClient } from "./mocks/MockMerchantAgentClient.js";
import { MockRealityClient } from "./mocks/MockRealityClient.js";
import { MockShopifyClient } from "./mocks/MockShopifyClient.js";
import { InMemorySessionRepository } from "./repositories.js";
import { buildServer } from "./server.js";
import { createOrderSession } from "./session/OrderSession.js";
import { Orchestrator } from "./workflow/Orchestrator.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function solve(input: SolverInput) {
  const candidate = input.candidates[0]!;
  return ProductionPlanSchema.parse({
    planId: `plan-${input.generation}`,
    orderId: input.orderId,
    intentVersion: input.intent.version,
    status: "VALID",
    nodes: [
      {
        nodeId: "node",
        merchantId: candidate.merchantId,
        capabilityId: candidate.capabilityId,
        kind: candidate.capability.kind,
        quantity: input.intent.quantity,
        unitCost: 1,
        totalCost: input.intent.quantity,
        startsAt: input.now,
        completesAt: input.intent.deadline,
      },
    ],
    edges: [],
    totalCost: input.intent.quantity,
    currency: "CAD",
    riskScore: 0,
    constraintResults: [],
    unsatRelaxations: [],
    estimatedCompletion: input.intent.deadline,
  });
}

async function fixture(directory?: string) {
  const store = new LocalStore(directory);
  await store.load();
  const session = createOrderSession();
  await store.create(session);
  const openai = new MockOpenAIAdapter();
  const solver = { solve: vi.fn(async (input: SolverInput) => solve(input)) };
  const reality = new MockRealityClient();
  const shopify = new MockShopifyClient();
  const orchestrator = new Orchestrator({
    sessions: store,
    events: store,
    openai,
    solver,
    reality,
    shopify,
    merchantAgents: new MockMerchantAgentClient(),
  });
  const app = await buildServer({
    config: ConfigSchema.parse({ DEMO_MODE: "true" }),
    sessions: store,
    events: store,
    desktopStore: store,
    openai,
    solver,
    orchestrator,
  });
  cleanup.push(() => app.close());
  const url = `/api/orders/${session.orderId}`;
  const input = {
    orderId: session.orderId,
    traceId: session.traceId,
    text: "Make 20 hoodies by 2026-10-01 CAD",
    locale: "en-CA",
    timeZone: "UTC",
    requestedAt: new Date().toISOString(),
    assets: [],
  };
  return {
    store,
    session,
    orchestrator,
    app,
    url,
    input,
    openai,
    solver,
    reality,
    shopify,
  };
}

describe("shared brain read models", () => {
  it("retains correction history and outcomes while unresolved details require clarification", async () => {
    const { orchestrator, openai, solver, store, input, session } =
      await fixture();
    const compiled = await openai.compileIntent(input);
    if (compiled.status !== "READY") throw new Error("Expected ready intent");
    const ambiguityFlags = [
      {
        field: "artwork",
        reason: "Missing artwork",
        question: "Supply a logo.",
      },
    ];
    vi.spyOn(openai, "compileIntent").mockResolvedValueOnce({
      status: "NEEDS_CLARIFICATION",
      draft: { ...compiled.intent, ambiguityFlags },
      questions: ["Supply a logo."],
    });
    const initial = await orchestrator.submitMessage(input);
    expect(initial.state).toBe("NEEDS_CLARIFICATION");
    const result = await orchestrator.revise(
      session.orderId,
      { name: "request_recompile", args: {} },
      "retry-clarification",
      "Try that plan again.",
      initial.revision,
    );
    expect(result.state).toBe("NEEDS_CLARIFICATION");
    expect(result.activePlan).toBeNull();
    expect(solver.solve).not.toHaveBeenCalled();
    const events = await store.list(session.orderId, 0);
    expect(events.map(({ event }) => event)).toContainEqual(
      expect.objectContaining({
        eventType: "intent.clarification.required",
        payload: {
          questions: ["Supply a logo."],
          intentVersion: result.intentVersion,
          state: "NEEDS_CLARIFICATION",
        },
      }),
    );
    const history = await readMessageHistory(store, session.orderId, 0, 50);
    expect(history.messages.at(-1)).toMatchObject({
      messageId: "retry-clarification",
      text: "Try that plan again.",
      source: "desktop",
      outcome: { status: "succeeded", resultRevision: result.revision },
    });
  });
  it.each(["memory", "local"])(
    "pages %s projects stably across updates with tied timestamps",
    async (kind) => {
      const store =
        kind === "memory" ? new InMemorySessionRepository() : new LocalStore();
      const a = {
        ...createOrderSession(new Date("2026-01-01T00:00:00.000Z")),
        orderId: "a",
      };
      const b = { ...a, orderId: "b" };
      const c = { ...a, orderId: "c", createdAt: "2025-01-01T00:00:00.000Z" };
      for (const session of [c, b, a]) await store.create(session);
      const first = await store.listProjects({ limit: 1, search: "" });
      expect(first.projects.map(({ orderId }) => orderId)).toEqual(["a"]);
      await store.save(
        { ...c, revision: 1, updatedAt: new Date().toISOString() },
        0,
      );
      const next = await store.listProjects({
        limit: 2,
        search: "",
        cursor: first.nextCursor!,
      });
      expect(next.projects.map(({ orderId }) => orderId)).toEqual(["b", "c"]);
      expect(next.nextCursor).toBeNull();
      expect(
        (await store.listProjects({ limit: 2, search: "UNTITLED" })).projects,
      ).toHaveLength(2);
      await expect(
        store.listProjects({ limit: 2, search: "", cursor: "invalid" }),
      ).rejects.toThrow();
    },
  );

  it("rejects unbounded discovery/history queries and keeps legacy snapshots strict", async () => {
    const { app, session, url } = await fixture();
    for (const query of [
      "limit=101",
      "limit=0",
      `search=${"x".repeat(201)}`,
      "cursor=invalid",
    ]) {
      expect((await app.inject(`/api/projects?${query}`)).statusCode).toBe(400);
    }
    expect((await app.inject(`${url}/messages?limit=101`)).statusCode).toBe(
      400,
    );
    const projects = ProjectListSchema.parse(
      (await app.inject("/api/projects")).json(),
    );
    expect(projects.projects[0]?.orderId).toBe(session.orderId);
    expect(
      MessageHistorySchema.parse((await app.inject(`${url}/messages`)).json())
        .messages,
    ).toEqual([]);
    const snapshot = (await app.inject(url)).json();
    expect(OrderSessionSnapshotSchema.parse(snapshot)).toEqual(session);
    expect(
      OrderSessionSnapshotSchema.safeParse({ ...snapshot, messages: [] })
        .success,
    ).toBe(false);
  });

  it("persists exact web and desktop input/assets and outcomes across restart without replaying", async () => {
    const directory = await mkdtemp(join(homedir(), "molecule-brain-test-"));
    cleanup.push(() => rm(directory, { recursive: true }));
    const { app, url, session, openai, store } = await fixture(directory);
    const compile = vi.spyOn(openai, "compileIntent");
    const asset = {
      assetId: "brand",
      name: "brand.txt",
      mimeType: "text/plain",
      checksum: "a".repeat(64),
    };
    const text = "  Make 20 hoodies by 2026-10-01 CAD\n";
    const request = {
      method: "POST" as const,
      url: `${url}/messages`,
      headers: { "x-action-id": "web-one" },
      payload: { text, assets: [asset], expectedRevision: 0 },
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(compile).toHaveBeenCalledTimes(1);
    await store.saveContext({
      orderId: session.orderId,
      asset,
      attached: true,
    });
    const desktopText = "No polyester.\n";
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${session.orderId}/actions`,
      payload: {
        actionId: "desktop-two",
        originalText: desktopText,
        command: { name: "start_project", args: { intent: desktopText } },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const restarted = new LocalStore(directory);
    await restarted.load();
    const history = await readMessageHistory(restarted, session.orderId, 0, 1);
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]).toMatchObject({
      messageId: "web-one",
      text,
      assets: [asset],
      source: "web",
      acceptedRevision: 1,
      outcome: { status: "succeeded" },
    });
    const second = await readMessageHistory(
      restarted,
      session.orderId,
      history.nextCursor!,
      1,
    );
    expect(second.messages[0]).toMatchObject({
      messageId: "desktop-two",
      text: desktopText,
      assets: [asset],
      source: "desktop",
      outcome: { status: "succeeded" },
    });
    expect(second.nextCursor).toBeNull();
    const status = await new ActionLedger(restarted).status(session.orderId, {
      key: "web-one",
      kind: "message",
    });
    expect(status).toMatchObject({
      status: "succeeded",
      automaticRetryAllowed: false,
      resultState: "AWAITING_APPROVAL",
    });
    const desktop = ActionStatusSchema.parse(
      (await app.inject(`${url}/actions?key=desktop-two&kind=desktop`)).json(),
    );
    expect(desktop.status).toBe("succeeded");
    expect(
      await restarted.listProjects({ search: "", limit: 10 }),
    ).toMatchObject({
      projects: [{ orderId: session.orderId }],
    });
  });

  it("retains typed desktop corrections only when actual original text was supplied", async () => {
    const { orchestrator, input, session, app, url } = await fixture();
    await orchestrator.submitMessage(input);
    const text = "Please recompile the exact current brief.\n";
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${session.orderId}/actions`,
      payload: {
        actionId: "correction",
        originalText: text,
        command: { name: "request_recompile", args: {} },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const history = MessageHistorySchema.parse(
      (await app.inject(`${url}/messages`)).json(),
    );
    expect(history.messages.at(-1)).toMatchObject({
      text,
      messageId: "correction",
      outcome: { status: "succeeded" },
    });
    await orchestrator.revise(
      session.orderId,
      { name: "request_recompile", args: {} },
      "legacy",
    );
    expect(
      MessageHistorySchema.parse((await app.inject(`${url}/messages`)).json())
        .messages,
    ).toHaveLength(2);
  });

  it("rejects stale revisions before accepting input or invoking providers", async () => {
    const { app, openai, url } = await fixture();
    const compile = vi.spyOn(openai, "compileIntent");
    const response = await app.inject({
      method: "POST",
      url: `${url}/messages`,
      headers: { "x-action-id": "stale" },
      payload: { text: "No polyester", expectedRevision: 99 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("STALE_VERSION");
    expect(compile).not.toHaveBeenCalled();
    expect(
      MessageHistorySchema.parse((await app.inject(`${url}/messages`)).json())
        .messages,
    ).toEqual([]);
    expect(
      ActionStatusSchema.parse(
        (await app.inject(`${url}/actions?key=stale`)).json(),
      ),
    ).toMatchObject({
      status: "failed",
      error: { code: "STALE_VERSION" },
    });
  });

  it("exposes sanitized pending/failed receipts after restart and never retries them", async () => {
    const { app, store, session, url } = await fixture();
    const fingerprint = createHash("sha256").update("{}").digest("hex");
    await store.saveReceipt({
      key: `${session.orderId}:message:pending`,
      fingerprint,
      state: "pending",
    });
    await store.saveReceipt({
      key: `${session.orderId}:message:legacy-failed`,
      fingerprint: "opaque",
      state: "failed",
      error: "secret-token private reasoning",
    });
    const ledger = new ActionLedger(store);
    const operation = vi.fn(async () => "should not run");
    await expect(
      ledger.run(`${session.orderId}:message:pending`, {}, String, operation),
    ).rejects.toThrow(/unknown/);
    expect(operation).not.toHaveBeenCalled();
    for (const key of ["pending", "legacy-failed", "missing"]) {
      const response = await app.inject(`${url}/actions?key=${key}`);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("secret-token");
      const status = ActionStatusSchema.parse(response.json());
      expect(status.status).toBe(
        key === "missing"
          ? "unknown"
          : key === "pending"
            ? "pending"
            : "failed",
      );
      expect(status.automaticRetryAllowed).toBe(false);
    }
    const other = createOrderSession();
    await store.create(other);
    expect(
      (await ledger.status(other.orderId, { key: "pending", kind: "message" }))
        .status,
    ).toBe("unknown");
  });

  it("reports a concurrent compiler loser as superseded without clobbering the winner", async () => {
    const { app, store, openai, input, session, url } = await fixture();
    const delayed = deferred<CompileIntentResult>();
    const entered = deferred<void>();
    const firstResult = await openai.compileIntent(input);
    vi.spyOn(openai, "compileIntent").mockImplementationOnce(() => {
      entered.resolve();
      return delayed.promise;
    });
    const first = app.inject({
      method: "POST",
      url: `${url}/messages`,
      headers: { "x-action-id": "loser" },
      payload: { text: input.text },
    });
    await entered.promise;
    expect(
      ActionStatusSchema.parse(
        (await app.inject(`${url}/actions?key=loser`)).json(),
      ).status,
    ).toBe("pending");
    const winner = await app.inject({
      method: "POST",
      url: `${url}/messages`,
      headers: { "x-action-id": "winner" },
      payload: { text: input.text.replace("20", "30") },
    });
    expect(winner.statusCode).toBe(200);
    delayed.resolve(firstResult);
    const loser = await first;
    expect(loser.statusCode).toBe(409);
    expect(loser.json().code).toBe("CONFLICT");
    expect((await store.get(session.orderId))?.revision).toBe(
      winner.json().revision,
    );
    expect(
      ActionStatusSchema.parse(
        (await app.inject(`${url}/actions?key=loser`)).json(),
      ).status,
    ).toBe("superseded");
    const history = MessageHistorySchema.parse(
      (await app.inject(`${url}/messages`)).json(),
    );
    expect(history.messages.map(({ outcome }) => outcome.status)).toEqual([
      "superseded",
      "succeeded",
    ]);
  });

  it("rejects a late solver result and preserves the newer generation", async () => {
    const { orchestrator, solver, input, store, session } = await fixture();
    const delayed = deferred<ReturnType<typeof solve>>();
    const entered = deferred<void>();
    let previous: ReturnType<typeof solve>;
    solver.solve.mockImplementationOnce(async (request) => {
      previous = solve(request);
      entered.resolve();
      return delayed.promise;
    });
    const first = orchestrator.submitMessage(input, { messageId: "old" });
    const rejected = expect(first).rejects.toThrow(/superseded/);
    await entered.promise;
    const winner = await orchestrator.submitMessage(
      { ...input, text: "No polyester." },
      { messageId: "new" },
    );
    delayed.resolve(previous!);
    await rejected;
    expect(await store.get(session.orderId)).toEqual(winner);
    expect(
      (await readMessageHistory(store, session.orderId, 0, 10)).messages[0]
        ?.outcome.status,
    ).toBe("superseded");
  });

  it("retains sanitized compiler failure status for lost responses", async () => {
    const { app, openai, input, url, store, session } = await fixture();
    vi.spyOn(openai, "compileIntent").mockRejectedValueOnce(
      new Error("private token=secret"),
    );
    const response = await app.inject({
      method: "POST",
      url: `${url}/messages`,
      headers: { "x-action-id": "failed" },
      payload: { text: input.text },
    });
    expect(response.statusCode).toBe(500);
    const status = await new ActionLedger(store).status(session.orderId, {
      key: "failed",
      kind: "message",
    });
    expect(status.status).toBe("failed");
    expect(status.error?.code).toBe("INTERNAL");
    expect(JSON.stringify(status)).not.toContain("private token");
    expect(
      (await readMessageHistory(store, session.orderId, 0, 10)).messages[0]
        ?.outcome.status,
    ).toBe("failed");
  });

  it.each(["search", "solver"])(
    "persists recovery %s failures and protects receipts",
    async (stage) => {
      const { orchestrator, store, session, input, reality, solver, shopify } =
        await fixture();
      const planned = await orchestrator.submitMessage(input);
      await orchestrator.approve(
        session.orderId,
        planned.activePlan!.planId,
        planned.intentVersion,
      );
      const before = await store.get(session.orderId);
      const commit = vi.spyOn(shopify, "commit");
      const error = new Error("private provider payload");
      if (stage === "search")
        vi.spyOn(reality, "searchCandidates").mockRejectedValueOnce(error);
      else solver.solve.mockRejectedValueOnce(error);
      await expect(
        orchestrator.recoverSupplier(
          session.orderId,
          planned.activePlan!.nodes[0]!.merchantId,
        ),
      ).rejects.toThrow(error);
      const failed = await store.get(session.orderId);
      expect(failed?.state).toBe("FAILED");
      expect(failed?.executionReceipt).toEqual(before?.executionReceipt);
      expect(
        (await orchestrator.capabilities(session.orderId)).capabilities,
      ).toMatchObject({
        canSubmitMessage: false,
        canCancelPlanning: false,
        requiresOperator: true,
      });
      await expect(orchestrator.cancel(session.orderId)).rejects.toThrow(
        /operator/,
      );
      await expect(orchestrator.submitMessage(input)).rejects.toThrow(
        /operator/,
      );
      expect(commit).not.toHaveBeenCalled();
      const events = await store.list(session.orderId, 0);
      const failure = events.find(
        ({ event }) => event.eventType === "recovery.failed",
      );
      expect(failure?.event.payload.reason).toEqual(expect.any(String));
      expect(JSON.stringify(events)).not.toContain("private provider payload");
    },
  );

  it("fences a late recovery exception after a newer correction wins", async () => {
    const { orchestrator, store, session, input, reality } = await fixture();
    const planned = await orchestrator.submitMessage(input);
    const delayed =
      deferred<Awaited<ReturnType<MockRealityClient["searchCandidates"]>>>();
    const entered = deferred<void>();
    vi.spyOn(reality, "searchCandidates").mockImplementationOnce(() => {
      entered.resolve();
      return delayed.promise;
    });
    const recovery = orchestrator.recoverSupplier(
      session.orderId,
      planned.activePlan!.nodes[0]!.merchantId,
    );
    const rejection = expect(recovery).rejects.toThrow(/superseded/);
    await entered.promise;
    const winner = await orchestrator.submitMessage({
      ...input,
      text: input.text.replace("20", "25"),
    });
    delayed.reject(new Error("late recovery error"));
    await rejection;
    expect(await store.get(session.orderId)).toEqual(winner);
    expect(
      (await store.list(session.orderId, 0)).some(
        ({ event }) => event.eventType === "recovery.failed",
      ),
    ).toBe(false);
  });

  it("preserves commerce receipts when supplier acceptance throws", async () => {
    const { orchestrator, store, input, session, shopify } = await fixture();
    const planned = await orchestrator.submitMessage(input);
    const receipt = await shopify.commit(planned.activePlan!, session.traceId);
    vi.spyOn(shopify, "commit").mockRejectedValueOnce(
      new ExecutionInterruptedError(receipt),
    );
    const failed = await orchestrator.approve(
      session.orderId,
      planned.activePlan!.planId,
      planned.intentVersion,
    );
    expect(failed.state).toBe("NEEDS_HUMAN");
    expect(failed.executionReceipt).toEqual(receipt);
    await expect(orchestrator.cancel(session.orderId)).rejects.toThrow(
      /operator/,
    );
    await expect(orchestrator.submitMessage(input)).rejects.toThrow(/operator/);
    expect((await store.get(session.orderId))?.executionReceipt).toEqual(
      receipt,
    );
  });

  it("does not let recovery steal an in-flight execution's receipt", async () => {
    const { orchestrator, input, session, shopify, store } = await fixture();
    const planned = await orchestrator.submitMessage(input);
    const receipt = await shopify.commit(planned.activePlan!, session.traceId);
    const delayed = deferred<typeof receipt>();
    const entered = deferred<void>();
    vi.spyOn(shopify, "commit").mockImplementationOnce(() => {
      entered.resolve();
      return delayed.promise;
    });
    const execution = orchestrator.approve(
      session.orderId,
      planned.activePlan!.planId,
      planned.intentVersion,
    );
    await entered.promise;
    await expect(
      orchestrator.recoverSupplier(
        session.orderId,
        planned.activePlan!.nodes[0]!.merchantId,
      ),
    ).rejects.toThrow(/cannot interrupt/);
    delayed.resolve(receipt);
    expect((await execution).state).toBe("COMPLETED");
    expect((await store.get(session.orderId))?.executionReceipt).toEqual(
      receipt,
    );
  });

  it("blocks cancellation/correction using durable execution events even without a receipt", async () => {
    const { store, orchestrator, session, input } = await fixture();
    await store.save({ ...session, state: "NEEDS_HUMAN", revision: 1 }, 0);
    await store.append(
      makeEvent({
        traceId: session.traceId,
        orderId: session.orderId,
        eventType: "execution.started",
        source: "orchestrator",
      }),
    );
    expect(
      (await orchestrator.capabilities(session.orderId)).capabilities
        .canSubmitMessage,
    ).toBe(false);
    await expect(orchestrator.cancel(session.orderId)).rejects.toThrow(
      /operator/,
    );
    await expect(orchestrator.submitMessage(input)).rejects.toThrow(/operator/);
  });
});
