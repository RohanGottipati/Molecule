import {
  ProductionPlanSchema,
  type ProductionPlan,
  type QuoteRequest,
  type QuoteResponse,
  type SolverInput,
} from "@molecule/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  MerchantAgentClient,
  OpenAIClient,
  SolverClient,
} from "../clients.js";
import { InMemoryEventStore } from "../events/EventStore.js";
import { MockMerchantAgentClient } from "../mocks/MockMerchantAgentClient.js";
import { MockRealityClient } from "../mocks/MockRealityClient.js";
import { MockShopifyClient } from "../mocks/MockShopifyClient.js";
import { InMemorySessionRepository } from "../repositories.js";
import { createOrderSession } from "../session/OrderSession.js";
import { Orchestrator } from "./Orchestrator.js";
import { MockOpenAIAdapter } from "@molecule/openai";

class ContractSolver implements SolverClient {
  async solve(input: SolverInput): Promise<ProductionPlan> {
    const candidates = input.candidates.filter((candidate) =>
      input.quotes.some(
        (quote) =>
          quote.capabilityId === candidate.capabilityId &&
          quote.status === "CAN_ACCEPT",
      ),
    );
    const requiredKinds = [
      "SUPPLY",
      ...input.intent.transformations.map(({ kind }) =>
        /assembl|pack/i.test(kind) ? "ASSEMBLE" : "TRANSFORM",
      ),
    ];
    const chosen = requiredKinds.map((kind) =>
      candidates.find((candidate) => candidate.capability.kind === kind),
    );
    if (chosen.some((candidate) => !candidate)) {
      return ProductionPlanSchema.parse({
        planId: `unsat-${input.generation}`,
        orderId: input.orderId,
        intentVersion: input.intent.version,
        status: "UNSAT",
        nodes: [],
        edges: [],
        totalCost: 0,
        currency: input.intent.currency,
        riskScore: 1,
        constraintResults: [
          {
            constraintId: "feasibility",
            satisfied: false,
            explanation: "Missing capability",
          },
        ],
        unsatRelaxations: [
          {
            constraintId: "deadline",
            proposedValue: input.intent.deadline,
            explanation: "Relax",
          },
        ],
      });
    }
    const nodes = chosen.map((candidate, index) => {
      const resolved = candidate!;
      const quote = input.quotes.find(
        (item) => item.capabilityId === resolved.capabilityId,
      )!;
      return {
        nodeId: `node-${index}-${resolved.capabilityId}`,
        merchantId: resolved.merchantId,
        capabilityId: resolved.capabilityId,
        kind: resolved.capability.kind,
        quantity: input.intent.quantity,
        unitCost: quote.unitPrice ?? 0,
        totalCost: (quote.unitPrice ?? 0) * input.intent.quantity,
        startsAt: input.now,
        completesAt: input.intent.deadline,
      };
    });
    return ProductionPlanSchema.parse({
      planId: `plan-${input.intent.version}-${input.generation}-${nodes.map(({ capabilityId }) => capabilityId).join("-")}`,
      orderId: input.orderId,
      intentVersion: input.intent.version,
      status: "VALID",
      nodes,
      edges: nodes.slice(1).map((node, index) => ({
        edgeId: `edge-${index}`,
        fromNodeId: nodes[index]!.nodeId,
        toNodeId: node.nodeId,
        material: "work-in-progress",
        quantity: input.intent.quantity,
        unit: "units",
      })),
      totalCost: nodes.reduce((total, node) => total + node.totalCost, 0),
      currency: input.intent.currency,
      estimatedCompletion: input.intent.deadline,
      riskScore: 0.2,
      constraintResults: [
        {
          constraintId: "feasibility",
          satisfied: true,
          explanation: "Certified",
        },
      ],
      unsatRelaxations: [],
    });
  }
}

async function fixture(
  merchantAgents: MerchantAgentClient = new MockMerchantAgentClient(),
  openai: OpenAIClient = new MockOpenAIAdapter(),
) {
  const sessions = new InMemorySessionRepository();
  const events = new InMemoryEventStore();
  const session = createOrderSession(new Date("2026-09-19T12:00:00.000Z"));
  await sessions.create(session);
  const orchestrator = new Orchestrator({
    sessions,
    events,
    openai,
    reality: new MockRealityClient(),
    merchantAgents,
    solver: new ContractSolver(),
    shopify: new MockShopifyClient(),
    quoteTimeoutMs: 20,
  });
  return { session, sessions, events, orchestrator };
}

describe("Orchestrator workflow", () => {
  const brief = {
    text: "Make 20 hoodies by 2026-10-01 CAD",
    locale: "en-CA",
    timeZone: "UTC",
    requestedAt: "2026-09-19T12:00:00.000Z",
    assets: [],
  };
  it("bounds quote fanout even when an adapter ignores cancellation", async () => {
    const { session, orchestrator } = await fixture({
      quote: () => new Promise<QuoteResponse>(() => {}),
    });
    const planned = await orchestrator.submitMessage({
      ...brief,
      orderId: session.orderId,
      traceId: session.traceId,
    });
    expect(planned.state).toBe("NEEDS_HUMAN");
    expect(planned.quotes).toEqual([]);
  });
  it("rejects quotes for a different merchant before solving", async () => {
    const adapter = new MockMerchantAgentClient();
    const { session, orchestrator } = await fixture({
      quote: async (request, signal) => ({
        ...(await adapter.quote(request, signal)),
        merchantId: "different-merchant",
      }),
    });
    const planned = await orchestrator.submitMessage({
      ...brief,
      orderId: session.orderId,
      traceId: session.traceId,
    });
    expect(planned.state).toBe("NEEDS_HUMAN");
    expect(planned.quotes).toEqual([]);
  });
  it("clears a prior compiler error when a new request succeeds", async () => {
    const openai = new MockOpenAIAdapter();
    vi.spyOn(openai, "compileIntent").mockRejectedValueOnce(
      new Error("temporary failure"),
    );
    const { session, sessions, orchestrator } = await fixture(
      undefined,
      openai,
    );
    const input = {
      ...brief,
      orderId: session.orderId,
      traceId: session.traceId,
    };
    await expect(orchestrator.submitMessage(input)).rejects.toThrow(
      "temporary failure",
    );
    expect((await sessions.get(session.orderId))?.lastErrorCode).toBe("Error");
    const planned = await orchestrator.submitMessage(input);
    expect(planned.state).toBe("AWAITING_APPROVAL");
    expect(planned.lastErrorCode).toBeNull();
  });
  it("runs compile, quote, solve, approval, and idempotent mock execution", async () => {
    const { session, events, orchestrator } = await fixture();
    const planned = await orchestrator.submitMessage({
      orderId: session.orderId,
      traceId: session.traceId,
      text: "Make 20 embroidered hoodies by 2026-10-01 under $1000 CAD",
      locale: "en-CA",
      timeZone: "America/Toronto",
      requestedAt: "2026-09-19T12:00:00.000Z",
      assets: [],
    });

    expect(planned.state).toBe("AWAITING_APPROVAL");
    expect(planned.activePlan?.status).toBe("VALID");
    const completed = await orchestrator.approve(
      planned.orderId,
      planned.activePlan!.planId,
      planned.intentVersion,
    );
    expect(completed.state).toBe("COMPLETED");
    expect(
      completed.executionReceipt?.actions.every(
        ({ status }) => status === "SUCCEEDED",
      ),
    ).toBe(true);
    const types = (await events.list(session.orderId, 0)).map(
      ({ event }) => event.eventType,
    );
    expect(types).toContain("solver.valid");
    expect(types).toContain("shopify.customer_order.created");
  });

  it("continues when one merchant quote fails", async () => {
    class OneFailureAgent implements MerchantAgentClient {
      private readonly fallback = new MockMerchantAgentClient();
      async quote(
        request: QuoteRequest,
        signal?: AbortSignal,
      ): Promise<QuoteResponse> {
        if (request.capabilityId === "supply-base") throw new Error("offline");
        return this.fallback.quote(request, signal);
      }
    }
    const { session, events, orchestrator } = await fixture(
      new OneFailureAgent(),
    );
    const planned = await orchestrator.submitMessage({
      orderId: session.orderId,
      traceId: session.traceId,
      text: "Make 20 hoodies by 2026-10-01 CAD",
      locale: "en-CA",
      timeZone: "UTC",
      requestedAt: "2026-09-19T12:00:00.000Z",
      assets: [],
    });
    expect(planned.state).toBe("AWAITING_APPROVAL");
    expect(
      (await events.list(session.orderId, 0)).some(
        ({ event }) => event.eventType === "merchant.quote.timeout",
      ),
    ).toBe(true);
  });

  it("turns a quote timeout storm into explicit human escalation", async () => {
    const unavailable: MerchantAgentClient = {
      quote: async () => {
        throw new DOMException("Timed out", "AbortError");
      },
    };
    const { session, events, orchestrator } = await fixture(unavailable);
    const result = await orchestrator.submitMessage({
      orderId: session.orderId,
      traceId: session.traceId,
      text: "Make 20 hoodies by 2026-10-01 CAD",
      locale: "en-CA",
      timeZone: "UTC",
      requestedAt: "2026-09-19T12:00:00.000Z",
      assets: [],
    });
    expect(result.state).toBe("NEEDS_HUMAN");
    expect(result.activePlan?.status).toBe("UNSAT");
    const timeoutCount = (await events.list(session.orderId, 0)).filter(
      ({ event }) => event.eventType === "merchant.quote.timeout",
    ).length;
    expect(timeoutCount).toBeGreaterThanOrEqual(2);
  });

  it("rejects stale approval and replans around an offline supplier", async () => {
    const { session, orchestrator } = await fixture();
    const planned = await orchestrator.submitMessage({
      orderId: session.orderId,
      traceId: session.traceId,
      text: "Make 20 hoodies by 2026-10-01 CAD",
      locale: "en-CA",
      timeZone: "UTC",
      requestedAt: "2026-09-19T12:00:00.000Z",
      assets: [],
    });
    await expect(
      orchestrator.approve(planned.orderId, "old-plan", planned.intentVersion),
    ).rejects.toThrow(/stale/);
    const completed = await orchestrator.approve(
      planned.orderId,
      planned.activePlan!.planId,
      planned.intentVersion,
    );
    const recovered = await orchestrator.recoverSupplier(
      completed.orderId,
      completed.activePlan!.nodes[0]!.merchantId,
    );
    expect(recovered.state).toBe("COMPLETED");
    expect(recovered.activePlan?.nodes[0]?.merchantId).not.toBe(
      completed.activePlan!.nodes[0]!.merchantId,
    );
  });
});
