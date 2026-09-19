import { ProductionPlanSchema } from "@molecule/contracts";
import { describe, expect, it } from "vitest";

import { MockShopifyClient } from "./MockShopifyClient.js";

describe("MockShopifyClient idempotency", () => {
  it("returns the same provider references for duplicate action keys", async () => {
    const plan = ProductionPlanSchema.parse({
      planId: "plan-1",
      orderId: "order-1",
      intentVersion: 1,
      status: "VALID",
      nodes: [
        {
          nodeId: "node-1",
          merchantId: "merchant-1",
          capabilityId: "capability-1",
          kind: "SUPPLY",
          quantity: 10,
          unitCost: 2,
          totalCost: 20,
        },
      ],
      edges: [],
      totalCost: 20,
      currency: "CAD",
      riskScore: 0.1,
      constraintResults: [
        {
          constraintId: "all",
          satisfied: true,
          explanation: "All constraints pass",
        },
      ],
      unsatRelaxations: [],
    });
    const client = new MockShopifyClient();
    const first = await client.commit(plan, "trace-1");
    const second = await client.commit(plan, "trace-1");
    expect(second).toEqual(first);
  });
});
