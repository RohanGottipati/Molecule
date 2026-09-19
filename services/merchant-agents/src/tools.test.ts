import { MockBackboardAdapter } from "@molecule/backboard";
import { QuoteResponseSchema } from "@molecule/contracts";
import { describe, expect, it } from "vitest";

import { InMemoryCanonicalDataClient } from "./canonicalDataClient.js";
import {
  InMemoryCapacityStore,
  InsufficientCapacityError,
} from "./capacityStore.js";
import { InMemoryJobDecisionStore, JobNotAcceptedError } from "./jobStore.js";
import { createMerchantAgentTools } from "./tools.js";

const merchantId = "stitchworks";
const capabilityId = "embroidery";
const traceId = "trace-1";

function seedStitchWorks() {
  const canonicalData = new InMemoryCanonicalDataClient();
  canonicalData.seedCapability({
    capabilityId,
    merchantId,
    kind: "TRANSFORM",
    name: "Embroidery",
    description: "Logo embroidery on cotton hoodies",
    accepts: [],
    produces: [],
    quantity: { min: 1, max: 100, unit: "units" },
    pricing: { currency: "CAD", unitPrice: 4.5, setupFee: 10 },
    leadTime: { min: 24, max: 48, unit: "hours" },
    capacity: { available: 20, maximum: 100, period: "day" },
    hardRules: [],
    softRules: [],
    sourceClaimIds: [],
  });
  canonicalData.seedInventory({
    merchantId,
    sku: "hoodie-black-m",
    available: 250,
    asOf: "2026-09-19T00:00:00.000Z",
  });
  canonicalData.seedClaims(merchantId, [
    {
      claimId: "claim-1",
      merchantId,
      field: "capacity.embroidery",
      normalizedValue: 20,
      normalizedUnit: "units/day",
      source: { kind: "note", reference: "maintenance-note-1" },
      ingestedAt: "2026-09-19T00:00:00.000Z",
      sourceAuthority: 0.9,
      extractionConfidence: 0.95,
      resolutionStatus: "active",
      evidenceText: "Machine #2 down; capacity reduced to 20/day.",
    },
  ]);

  const capacity = new InMemoryCapacityStore();
  capacity.seedCapacity(merchantId, capabilityId, 20);

  const jobs = new InMemoryJobDecisionStore();

  return { canonicalData, capacity, jobs };
}

function context(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    merchantId,
    threadId: "thread-1",
    traceId,
    orderId: "order-1",
    ...overrides,
  } as {
    merchantId: string;
    threadId: string;
    traceId: string;
    orderId?: string;
    actionKey?: string;
  };
}

describe("merchant agent read tools", () => {
  it("get_inventory returns the canonical snapshot for the merchant's SKU", async () => {
    const deps = seedStitchWorks();
    const [getInventory] = createMerchantAgentTools(deps);
    const result = await getInventory!.handler(
      { sku: "hoodie-black-m" },
      context(),
    );
    expect(result).toMatchObject({
      sku: "hoodie-black-m",
      available: 250,
      found: true,
    });
  });

  it("get_inventory reports not-found for an unknown SKU rather than guessing", async () => {
    const deps = seedStitchWorks();
    const [getInventory] = createMerchantAgentTools(deps);
    const result = await getInventory!.handler({ sku: "unknown" }, context());
    expect(result).toMatchObject({ found: false, available: 0 });
  });

  it("get_capacity reflects canonical capacity net of held reservations", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const getCapacity = tools.find((t) => t.name === "get_capacity")!;
    const reserveCapacity = tools.find((t) => t.name === "reserve_capacity")!;

    const before = await getCapacity.handler({ capabilityId }, context());
    expect(before).toMatchObject({ available: 20 });

    await reserveCapacity.handler(
      { capabilityId, quantity: 5 },
      context({ actionKey: "k1" }),
    );

    const after = await getCapacity.handler({ capabilityId }, context());
    expect(after).toMatchObject({ available: 15 });
  });

  it("get_canonical_claims returns only the requested fields", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const getClaims = tools.find((t) => t.name === "get_canonical_claims")!;
    const result = (await getClaims.handler(
      { fields: ["capacity.embroidery"] },
      context(),
    )) as { claims: unknown[] };
    expect(result.claims).toHaveLength(1);

    const missing = (await getClaims.handler(
      { fields: ["pricing.unit"] },
      context(),
    )) as { claims: unknown[] };
    expect(missing.claims).toHaveLength(0);
  });
});

describe("calculate_quote", () => {
  it("returns CAN_ACCEPT validated against QuoteResponseSchema when in range and within live capacity", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const calculateQuote = tools.find((t) => t.name === "calculate_quote")!;

    const result = await calculateQuote.handler(
      { capabilityId, quantity: 10 },
      context(),
    );

    const parsed = QuoteResponseSchema.parse(result);
    expect(parsed.status).toBe("CAN_ACCEPT");
    expect(parsed.unitPrice).toBe(4.5);
  });

  it("declines when the requested quantity exceeds live capacity, even though it's within the capability's range", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const calculateQuote = tools.find((t) => t.name === "calculate_quote")!;

    // StitchWorks' capability range allows up to 100, but its live capacity
    // (machine #2 outage) is only 20 — the B5 rule this proves at the store
    // level, without depending on Backboard memory.
    const result = await calculateQuote.handler(
      { capabilityId, quantity: 55 },
      context(),
    );

    const parsed = QuoteResponseSchema.parse(result);
    expect(parsed.status).toBe("DECLINE");
  });

  it("declines for an unknown capability without fabricating a price", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const calculateQuote = tools.find((t) => t.name === "calculate_quote")!;

    const result = await calculateQuote.handler(
      { capabilityId: "laser-engraving", quantity: 5 },
      context(),
    );

    const parsed = QuoteResponseSchema.parse(result);
    expect(parsed.status).toBe("DECLINE");
  });
});

describe("reserve_capacity / release_capacity", () => {
  it("creates exactly one reservation under retry with the same server-derived actionKey", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const reserveCapacity = tools.find((t) => t.name === "reserve_capacity")!;
    const actionKey = reserveCapacity.actionKeyFor!(
      { capabilityId, quantity: 5 },
      context(),
    )!;

    const first = await reserveCapacity.handler(
      { capabilityId, quantity: 5 },
      context({ actionKey }),
    );
    const retry = await reserveCapacity.handler(
      { capabilityId, quantity: 5 },
      context({ actionKey }),
    );

    expect(first).toEqual(retry);

    const getCapacity = tools.find((t) => t.name === "get_capacity")!;
    const capacityAfter = await getCapacity.handler(
      { capabilityId },
      context(),
    );
    // 20 total minus a single 5-unit hold, not two.
    expect(capacityAfter).toMatchObject({ available: 15 });
  });

  it("rejects a reservation that would exceed live capacity", async () => {
    const deps = seedStitchWorks();
    await expect(
      deps.capacity.reserve({
        merchantId,
        capabilityId,
        orderId: "order-1",
        quantity: 999,
        actionKey: "over",
      }),
    ).rejects.toBeInstanceOf(InsufficientCapacityError);
  });

  it("does not let two concurrently-issued reservations overbook the same capability", async () => {
    const deps = seedStitchWorks();
    const [a, b] = await Promise.allSettled([
      deps.capacity.reserve({
        merchantId,
        capabilityId,
        orderId: "order-1",
        quantity: 15,
        actionKey: "order-1-hold",
      }),
      deps.capacity.reserve({
        merchantId,
        capabilityId,
        orderId: "order-2",
        quantity: 15,
        actionKey: "order-2-hold",
      }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("release_capacity frees the reservation's units back to availability", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const reserveCapacity = tools.find((t) => t.name === "reserve_capacity")!;
    const releaseCapacity = tools.find((t) => t.name === "release_capacity")!;
    const getCapacity = tools.find((t) => t.name === "get_capacity")!;

    const reservation = (await reserveCapacity.handler(
      { capabilityId, quantity: 8 },
      context({ actionKey: "hold-1" }),
    )) as { reservationId: string };

    await releaseCapacity.handler(
      { capabilityId, reservationId: reservation.reservationId },
      context({ actionKey: "release-1" }),
    );

    const after = await getCapacity.handler({ capabilityId }, context());
    expect(after).toMatchObject({ available: 20 });
  });
});

describe("accept_job / decline_job / update_eta", () => {
  it("accepts a job, then allows updating its ETA idempotently", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const acceptJob = tools.find((t) => t.name === "accept_job")!;
    const updateEta = tools.find((t) => t.name === "update_eta")!;

    await acceptJob.handler(
      { nodeId: "node-1" },
      context({ actionKey: "accept-1" }),
    );

    const first = await updateEta.handler(
      { nodeId: "node-1", eta: "2026-09-20T12:00:00.000Z" },
      context({ actionKey: "eta-1" }),
    );
    const retry = await updateEta.handler(
      { nodeId: "node-1", eta: "2026-09-20T12:00:00.000Z" },
      context({ actionKey: "eta-1" }),
    );

    expect(first).toEqual(retry);
    expect(first).toMatchObject({ eta: "2026-09-20T12:00:00.000Z" });
  });

  it("refuses to set an ETA on a job that was never accepted", async () => {
    const deps = seedStitchWorks();
    await expect(
      deps.jobs.updateEta({
        merchantId,
        orderId: "order-1",
        nodeId: "node-never-accepted",
        eta: "2026-09-20T12:00:00.000Z",
        actionKey: "eta-x",
      }),
    ).rejects.toBeInstanceOf(JobNotAcceptedError);
  });

  it("decline_job records a reason and is idempotent under retry", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const declineJob = tools.find((t) => t.name === "decline_job")!;

    const first = await declineJob.handler(
      {
        nodeId: "node-2",
        reason: "rush quantity exceeds machine #2 outage limit",
      },
      context({ actionKey: "decline-1" }),
    );
    const retry = await declineJob.handler(
      {
        nodeId: "node-2",
        reason: "rush quantity exceeds machine #2 outage limit",
      },
      context({ actionKey: "decline-1" }),
    );

    expect(first).toEqual(retry);
    expect(first).toMatchObject({ status: "declined" });
  });
});

describe("mutating tool guard and structured transcript", () => {
  it("rejects reserve_capacity through the bounded loop when server context lacks orderId", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "StitchWorks",
      specialty: "embroidery",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    adapter.programThread(thread.threadId, [
      {
        type: "tool_call",
        name: "reserve_capacity",
        args: { capabilityId, quantity: 5 },
      },
    ]);

    const result = await adapter.sendWithTools({
      merchantId,
      assistantId: assistant.assistantId,
      threadId: thread.threadId,
      traceId,
      message: "reserve please",
      orderId: undefined,
      tools,
    });

    expect(result.outcome).toBe("FALLBACK");
    if (result.outcome === "FALLBACK") {
      expect(result.reason).toBe("TOOL_GUARD_REJECTED");
    }
  });

  it("runs get_capacity then reserve_capacity through the bounded loop and records a structured, non-reasoning transcript", async () => {
    const deps = seedStitchWorks();
    const tools = createMerchantAgentTools(deps);
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "StitchWorks",
      specialty: "embroidery",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    adapter.programThread(thread.threadId, [
      { type: "tool_call", name: "get_capacity", args: { capabilityId } },
      {
        type: "tool_call",
        name: "reserve_capacity",
        args: { capabilityId, quantity: 5 },
      },
      { type: "final", text: "reserved 5 units" },
    ]);

    const result = await adapter.sendWithTools({
      merchantId,
      assistantId: assistant.assistantId,
      threadId: thread.threadId,
      traceId,
      message: "check and reserve",
      orderId: "order-1",
      tools,
    });

    expect(result.outcome).toBe("COMPLETED");
    expect(result.toolCalls).toHaveLength(2);
    for (const call of result.toolCalls) {
      expect(Object.keys(call).sort()).toEqual(
        ["args", "finishedAt", "result", "startedAt", "toolName"].sort(),
      );
    }
    expect(result.toolCalls[1]?.result).toMatchObject({
      status: "held",
      quantity: 5,
    });
  });
});
