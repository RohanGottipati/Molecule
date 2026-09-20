import {
  GOLDEN_PATH_CORRECTION,
  GOLDEN_PATH_PROMPT,
  ProductionPlanSchema,
  type ProductionPlan,
  type SolverInput,
} from "@molecule/contracts";
import { GoldenPathOpenAIAdapter, MockOpenAIAdapter } from "@molecule/openai";
import { describe, expect, it } from "vitest";

import type { SolverClient } from "../clients.js";
import { InMemoryEventStore } from "../events/EventStore.js";
import { MockMerchantAgentClient } from "../mocks/MockMerchantAgentClient.js";
import { MockRealityClient } from "../mocks/MockRealityClient.js";
import { MockShopifyClient } from "../mocks/MockShopifyClient.js";
import { InMemorySessionRepository } from "../repositories.js";
import { createOrderSession, toSnapshot } from "../session/OrderSession.js";
import { Orchestrator } from "../workflow/Orchestrator.js";
import {
  GOLDEN_PATH_EXPECTATION,
  goldenPathDeviations,
  goldenPathEventDeviations,
} from "./goldenPath.js";

/**
 * Deterministic stand-in for CP-SAT that picks the golden-path nodes from the
 * demo catalog; scripts/verify-golden.mjs covers the real solver.
 */
class GoldenCatalogSolver implements SolverClient {
  async solve(input: SolverInput): Promise<ProductionPlan> {
    const nodes = Object.entries(GOLDEN_PATH_EXPECTATION.planNodes).map(
      ([capabilityId, merchantId]) => {
        const candidate = input.candidates.find(
          (item) => item.capabilityId === capabilityId,
        );
        const quote = input.quotes.find(
          (item) =>
            item.capabilityId === capabilityId && item.status === "CAN_ACCEPT",
        );
        if (!candidate || !quote)
          throw new Error(`golden capability ${capabilityId} unavailable`);
        const unitCost = quote.unitPrice ?? 0;
        return {
          nodeId: `node-${capabilityId}`,
          merchantId,
          capabilityId,
          kind: candidate.capability.kind,
          quantity: input.intent.quantity,
          unitCost,
          totalCost: unitCost * input.intent.quantity + (quote.setupFee ?? 0),
          startsAt: input.now,
          completesAt: input.intent.deadline,
        };
      },
    );
    const edge = (from: string, to: string) => ({
      edgeId: `${from}->${to}`,
      fromNodeId: `node-${from}`,
      toNodeId: `node-${to}`,
      material: from,
      quantity: input.intent.quantity,
      unit: "units",
    });
    return ProductionPlanSchema.parse({
      planId: `golden-${input.intent.version}-${input.generation}`,
      orderId: input.orderId,
      intentVersion: input.intent.version,
      status: "VALID",
      nodes,
      edges: [
        edge("supply-base", "transform-thread"),
        edge("supply-bottle", "transform-laser"),
        edge("transform-thread", "assemble-pack"),
        edge("transform-laser", "assemble-pack"),
        edge("supply-snacks", "assemble-pack"),
        edge("assemble-pack", "fulfill-pack"),
      ],
      totalCost: nodes.reduce((total, node) => total + node.totalCost, 0),
      currency: input.intent.currency,
      estimatedCompletion: input.intent.deadline,
      riskScore: 0.1,
      constraintResults: input.intent.hardConstraints.map((constraint) => ({
        constraintId: constraint.constraintId,
        satisfied: true,
        explanation: "Certified by fixture",
      })),
      unsatRelaxations: [],
    });
  }
}

async function fixture() {
  const sessions = new InMemorySessionRepository();
  const events = new InMemoryEventStore();
  const session = createOrderSession(new Date("2026-09-20T07:00:00.000Z"));
  await sessions.create(session);
  const orchestrator = new Orchestrator({
    sessions,
    events,
    contexts: { contexts: () => [] },
    openai: new GoldenPathOpenAIAdapter(new MockOpenAIAdapter()),
    reality: new MockRealityClient(),
    merchantAgents: new MockMerchantAgentClient(),
    solver: new GoldenCatalogSolver(),
    shopify: new MockShopifyClient(),
    quoteTimeoutMs: 1000,
  });
  return { session, events, orchestrator };
}

const brief = {
  locale: "en-CA",
  timeZone: "America/Toronto",
  requestedAt: "2026-09-20T07:00:00.000Z",
  assets: [],
};

describe("golden path pipeline", () => {
  it("runs the canonical brief to a completed synthetic order without questions", async () => {
    const { session, events, orchestrator } = await fixture();
    const planned = await orchestrator.submitMessage(
      {
        ...brief,
        orderId: session.orderId,
        traceId: session.traceId,
        text: GOLDEN_PATH_PROMPT,
      },
      { messageId: "golden-brief", source: "web" },
    );
    expect(goldenPathDeviations(toSnapshot(planned), "planned")).toEqual([]);
    expect(planned.activePlan?.totalCost).toBe(
      GOLDEN_PATH_EXPECTATION.totalCost,
    );

    const completed = await orchestrator.approve(
      planned.orderId,
      planned.activePlan!.planId,
      planned.intentVersion,
    );
    expect(goldenPathDeviations(toSnapshot(completed), "completed")).toEqual(
      [],
    );

    const replay = await orchestrator.approve(
      planned.orderId,
      planned.activePlan!.planId,
      planned.intentVersion,
    );
    expect(replay.executionReceipt).toEqual(completed.executionReceipt);

    const recorded = (await events.list(session.orderId, 0)).map(
      ({ event }) => event,
    );
    expect(goldenPathEventDeviations(recorded)).toEqual([]);
    expect(recorded.every((event) => event.traceId === session.traceId)).toBe(
      true,
    );
  });

  it("applies the canonical correction and replans without questions", async () => {
    const { session, orchestrator } = await fixture();
    const planned = await orchestrator.submitMessage(
      {
        ...brief,
        orderId: session.orderId,
        traceId: session.traceId,
        text: GOLDEN_PATH_PROMPT,
      },
      { messageId: "golden-brief", source: "web" },
    );
    const corrected = await orchestrator.submitMessage(
      {
        ...brief,
        orderId: session.orderId,
        traceId: session.traceId,
        text: GOLDEN_PATH_CORRECTION,
        correction: { kind: "constraint", text: GOLDEN_PATH_CORRECTION },
      },
      { messageId: "golden-correction", source: "web" },
    );
    expect(corrected.intentVersion).toBe(planned.intentVersion + 1);
    expect(corrected.intent?.hardConstraints.at(-1)?.constraintId).toBe(
      "no-polyester",
    );
    expect(goldenPathDeviations(toSnapshot(corrected), "planned")).toEqual([]);
    expect(corrected.activePlan?.planId).not.toBe(planned.activePlan?.planId);
  });

  it("reports deviations instead of silently passing a degraded run", () => {
    const session = createOrderSession(new Date("2026-09-20T07:00:00.000Z"));
    const deviations = goldenPathDeviations(toSnapshot(session), "planned");
    expect(deviations).toContain("intent was not compiled");
    expect(deviations).toContain("state REQUESTED");
    expect(goldenPathEventDeviations([])).toHaveLength(
      GOLDEN_PATH_EXPECTATION.eventOrder.length,
    );
  });
});
