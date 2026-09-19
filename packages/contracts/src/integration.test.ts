import { describe, expect, it } from "vitest";

import { CurrentQuoteRequestSchema, QuoteRequestSchema } from "./index.js";

describe("integrated merchant quote contracts", () => {
  const request = {
    orderId: "order-1",
    traceId: "trace-1",
    merchantId: "merchant-1",
    capabilityId: "embroidery",
    quantity: 200,
    currency: "CAD",
  };

  it("preserves orchestrator constraints for the Backboard quote protocol", () => {
    const constraint = {
      constraintId: "material-1",
      field: "material",
      operator: "not_contains",
      value: "polyester",
    };
    const parsed = QuoteRequestSchema.parse({
      ...request,
      intentVersion: 2,
      hardConstraints: [constraint],
      deadline: "2026-09-25T18:00:00.000Z",
    });
    expect(parsed.constraints).toEqual([constraint]);
    expect(parsed.hardConstraints).toEqual([constraint]);
    expect(parsed.intentVersion).toBe(2);
    expect(QuoteRequestSchema.parse(parsed).constraints).toHaveLength(1);
  });

  it("requires a deadline for executable orchestrator quotes", () => {
    expect(CurrentQuoteRequestSchema.safeParse(request).success).toBe(false);
  });
});
