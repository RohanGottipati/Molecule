import { describe, expect, it } from "vitest";

import {
  CompileIntentResultSchema,
  MoleculeEventSchema,
  ProductIntentDraftSchema,
  ProductionPlanSchema,
  SolverInputSchema,
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

describe("ProductIntentDraftSchema", () => {
  it("preserves missing operational facts without inventing placeholders", () => {
    const draft = ProductIntentDraftSchema.parse({
      intentId: "7b423f38-4ee8-45e8-ab06-f70476201b0e",
      version: 1,
      quantity: null,
      deadline: null,
      currency: null,
      budgetMax: null,
      desiredOutputs: [],
      transformations: [],
      hardConstraints: [],
      softPreferences: [],
      assets: [],
      ambiguityFlags: [
        { field: "quantity", reason: "missing", question: "How many?" },
      ],
    });

    expect(draft.quantity).toBeNull();
  });
});

describe("CompileIntentResultSchema", () => {
  it("requires at least one question when clarification is needed", () => {
    const result = CompileIntentResultSchema.safeParse({
      status: "NEEDS_CLARIFICATION",
      draft: {
        intentId: "7b423f38-4ee8-45e8-ab06-f70476201b0e",
        version: 1,
        quantity: null,
        deadline: null,
        currency: null,
        budgetMax: null,
        desiredOutputs: [],
        transformations: [],
        hardConstraints: [],
        softPreferences: [],
        assets: [],
        ambiguityFlags: [],
      },
      questions: [],
    });

    expect(result.success).toBe(false);
  });
});

describe("SolverInputSchema", () => {
  it("rejects candidates without canonical capability data", () => {
    const result = SolverInputSchema.safeParse({
      orderId: "order-1",
      traceId: "trace-1",
      generation: 1,
      now: "2026-09-19T12:00:00.000Z",
      intent: {},
      candidates: [{ capabilityId: "cap-1", merchantId: "m-1", score: 1 }],
      quotes: [],
      changePenaltyNodeIds: [],
    });

    expect(result.success).toBe(false);
  });
});
