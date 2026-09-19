import { describe, expect, it } from "vitest";

import {
  MerchantMemoryCardEntrySchema,
  MoleculeEventSchema,
  ProductionPlanSchema,
  QuoteRequestSchema,
  RecommendationSetSchema,
} from "./index.js";

describe("ProductionPlanSchema", () => {
  it("rejects a VALID plan with a failed constraint", () => {
    const result = ProductionPlanSchema.safeParse({
      planId: "plan-1",
      orderId: "order-1",
      intentVersion: 1,
      status: "VALID",
      nodes: [],
      edges: [],
      totalCost: 0,
      currency: "CAD",
      riskScore: 0,
      constraintResults: [
        {
          constraintId: "deadline",
          satisfied: false,
          explanation: "Completion is after the deadline",
        },
      ],
      unsatRelaxations: [],
    });

    expect(result.success).toBe(false);
  });
});

describe("QuoteRequestSchema", () => {
  it("defaults hold to false and relevantClaimFields/constraints to empty", () => {
    const parsed = QuoteRequestSchema.parse({
      orderId: "order-1",
      traceId: "trace-1",
      merchantId: "merchant-1",
      capabilityId: "embroidery",
      quantity: 10,
      currency: "CAD",
    });

    expect(parsed.hold).toBe(false);
    expect(parsed.relevantClaimFields).toEqual([]);
    expect(parsed.constraints).toEqual([]);
  });

  it("rejects a non-positive quantity", () => {
    const result = QuoteRequestSchema.safeParse({
      orderId: "order-1",
      traceId: "trace-1",
      merchantId: "merchant-1",
      capabilityId: "embroidery",
      quantity: 0,
      currency: "CAD",
    });

    expect(result.success).toBe(false);
  });
});

describe("MerchantMemoryCardEntrySchema", () => {
  it("accepts a sanitized fact with no hidden-reasoning fields", () => {
    const parsed = MerchantMemoryCardEntrySchema.parse({
      merchantId: "stitchworks",
      memoryId: "mem-1",
      note: "Never auto-accept rush embroidery above 40 units while machine #2 is down.",
      sourceThreadId: "thread-1",
      recordedAt: "2026-01-15T00:00:00.000Z",
    });

    expect(parsed.note).toContain("40 units");
  });

  it("rejects an empty note", () => {
    const result = MerchantMemoryCardEntrySchema.safeParse({
      merchantId: "stitchworks",
      memoryId: "mem-1",
      note: "",
      recordedAt: "2026-01-15T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});

describe("RecommendationSetSchema", () => {
  function recommendation(
    perspective: "operations" | "risk" | "contract",
    overrides: Record<string, unknown> = {},
  ) {
    return {
      perspective,
      position: "APPROVE",
      rationale: "ok",
      confidence: 0.8,
      ...overrides,
    };
  }

  it("accepts exactly three recommendations, one per fixed perspective", () => {
    const parsed = RecommendationSetSchema.parse({
      orderId: "order-1",
      merchantId: "merchant-1",
      traceId: "trace-1",
      scenario: "deadline_guarantee",
      recommendations: [
        recommendation("operations"),
        recommendation("risk", { position: "REJECT" }),
        recommendation("contract", { position: "APPROVE_WITH_CONDITIONS" }),
      ],
      generatedAt: "2026-01-15T00:00:00.000Z",
    });

    expect(parsed.recommendations).toHaveLength(3);
  });

  it("rejects a set with fewer than three recommendations", () => {
    const result = RecommendationSetSchema.safeParse({
      orderId: "order-1",
      merchantId: "merchant-1",
      traceId: "trace-1",
      scenario: "deadline_guarantee",
      recommendations: [recommendation("operations"), recommendation("risk")],
      generatedAt: "2026-01-15T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});

describe("MoleculeEventSchema", () => {
  it("requires a UUID event ID and trace ID", () => {
    const result = MoleculeEventSchema.safeParse({
      eventId: "not-a-uuid",
      traceId: "",
      eventType: "intent.received",
      ts: "2026-09-19T12:00:00.000Z",
      severity: "INFO",
      source: "ui",
      payload: {},
    });

    expect(result.success).toBe(false);
  });
});
