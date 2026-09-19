import { describe, expect, it } from "vitest";

import { MoleculeEventSchema } from "@molecule/contracts";

describe("MoleculeEventSchema (used by appendEvent before persisting)", () => {
  it("accepts a well-formed event", () => {
    const result = MoleculeEventSchema.safeParse({
      eventId: "3fbe7f0a-1b1e-4a1b-8a4a-000000000001",
      traceId: "trace-1",
      orderId: "order-1",
      eventType: "reality.claim.resolved",
      ts: new Date().toISOString(),
      severity: "INFO",
      source: "rox",
      payload: { field: "capacity_per_day", value: 20 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown source", () => {
    const result = MoleculeEventSchema.safeParse({
      eventId: "3fbe7f0a-1b1e-4a1b-8a4a-000000000002",
      traceId: "trace-1",
      eventType: "reality.claim.resolved",
      ts: new Date().toISOString(),
      severity: "INFO",
      source: "not-a-real-source",
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});
