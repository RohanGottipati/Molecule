import { describe, expect, it } from "vitest";

import { MoleculeEventSchema, ProductionPlanSchema } from "./index.js";

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
