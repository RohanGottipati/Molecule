import {
  CanonicalClaimSchema,
  MerchantCapabilitySchema,
  QuoteRequestSchema,
} from "@molecule/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryCanonicalDataClient } from "./canonicalDataClient.js";
import { InMemoryCapacityStore } from "./capacityStore.js";
import { InMemoryJobDecisionStore } from "./jobStore.js";
import { createMerchantAgentTools } from "./tools.js";
import { groundQuote } from "./groundQuote.js";

const now = new Date("2026-09-21T12:00:00.000Z");
function setup() {
  const capability = MerchantCapabilitySchema.parse({
    merchantId: "merchant",
    capabilityId: "cap",
    name: "Hoodie",
    kind: "SUPPLY",
    description: "Synthetic fixture",
    accepts: [],
    hardRules: [],
    softRules: [],
    sourceClaimIds: [],
    produces: [
      {
        name: "hoodie",
        kind: "hoodie",
        attributes: { sku: "hoodie", material: "cotton" },
      },
    ],
    quantity: { min: 1, max: 100, unit: "units" },
    pricing: { currency: "CAD", unitPrice: 12, setupFee: 10 },
    capacity: { available: 100, period: "day" },
    leadTime: { min: 12, max: 24, unit: "hours" },
  });
  const canonicalData = new InMemoryCanonicalDataClient();
  canonicalData.seedCapability(capability);
  canonicalData.seedInventory({
    merchantId: "merchant",
    sku: "hoodie",
    available: 100,
    asOf: now.toISOString(),
  });
  const capacity = new InMemoryCapacityStore();
  capacity.seedCapacity("merchant", "cap", 100);
  const tools = createMerchantAgentTools({
    canonicalData,
    capacity,
    jobs: new InMemoryJobDecisionStore(),
  });
  return {
    capability,
    claims: (field: string, value: unknown, status = "active") =>
      canonicalData.seedClaims("merchant", [
        CanonicalClaimSchema.parse({
          claimId: "claim",
          merchantId: "merchant",
          field,
          normalizedValue: value,
          source: { kind: "manual", reference: "fixture" },
          ingestedAt: now.toISOString(),
          sourceAuthority: 1,
          extractionConfidence: 1,
          resolutionStatus: status,
        }),
      ]),
    quote: (overrides: Record<string, unknown> = {}) =>
      groundQuote(
        QuoteRequestSchema.parse({
          merchantId: "merchant",
          capabilityId: "cap",
          orderId: "order",
          traceId: "trace",
          quantity: 5,
          currency: "CAD",
          ...overrides,
        }),
        tools,
        {
          merchantId: "merchant",
          threadId: "thread",
          orderId: "order",
          traceId: "trace",
        },
        now,
        new AbortController().signal,
      ),
  };
}

describe("canonical quote evidence", () => {
  it.each(["neq", "not_contains"])(
    "does not infer %s from a null material",
    async (operator) => {
      const fixture = setup();
      fixture.capability.produces[0]!.attributes.material = null;
      expect(
        (
          await fixture.quote({
            constraints: [
              {
                constraintId: "material",
                field: "hoodie.material",
                operator,
                value: "polyester",
              },
            ],
          })
        ).quote.status,
      ).toBe("DECLINE");
    },
  );

  it.each([
    ["price", 99],
    ["cap.price", 99],
    ["setup_fee", 99],
    ["cap.setup_fee", 99],
    ["currency", "USD"],
    ["cap.capacity_per_day", 2],
    ["status", "offline"],
    ["cap.status", "unknown"],
    ["lead_time_hours", 72],
    ["cap.lead_time_hours", 72],
  ])(
    "does not accept stale capability data contradicting %s",
    async (field, value) => {
      const fixture = setup();
      fixture.claims(String(field), value);
      expect((await fixture.quote()).quote.status).toBe("DECLINE");
    },
  );

  it("does not advertise capacity above active evidence", async () => {
    const fixture = setup();
    fixture.claims("cap.capacity_per_day", 20);
    expect((await fixture.quote()).quote).toMatchObject({
      status: "CAN_ACCEPT",
      maxQuantity: 20,
    });
  });

  it("includes merchant hard rules when checking unresolved evidence", async () => {
    const fixture = setup();
    fixture.capability.hardRules = [
      {
        constraintId: "material",
        field: "hoodie.material",
        operator: "eq",
        value: "cotton",
        severity: "hard",
        origin: "merchant",
      },
    ];
    fixture.claims("hoodie.material", "cotton", "conflicted");
    expect((await fixture.quote()).quote.status).toBe("DECLINE");
  });
});
