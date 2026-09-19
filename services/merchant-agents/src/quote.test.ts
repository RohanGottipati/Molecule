import {
  createMerchantTwinService,
  createModelRouter,
  InMemoryMerchantAgentRepository,
  MockBackboardAdapter,
} from "@molecule/backboard";
import type { RecommendationSet } from "@molecule/contracts";
import { describe, expect, it, vi } from "vitest";

import { InMemoryCanonicalDataClient } from "./canonicalDataClient.js";
import { InMemoryCapacityStore } from "./capacityStore.js";
import { InMemoryJobDecisionStore } from "./jobStore.js";
import {
  createQuoteService,
  MerchantQuoteUnavailableError,
  QuoteProtocolError,
} from "./quote.js";

const traceId = "trace-1";

async function setupMerchant(params: {
  merchantId: string;
  capabilityId: string;
  orderId: string;
  capacityAvailable?: number;
  boundaries?: string[];
  council?: {
    enabled: boolean;
    onRecommendation?: (recommendationSet: RecommendationSet) => void;
  };
}) {
  const {
    merchantId,
    capabilityId,
    orderId,
    capacityAvailable = 20,
    boundaries = [],
    council,
  } = params;

  const adapter = new MockBackboardAdapter();
  const repository = new InMemoryMerchantAgentRepository();
  const twin = createMerchantTwinService(adapter, repository);

  await twin.ensureAssistant({
    merchantId,
    displayName: merchantId,
    specialty: "test",
    boundaries,
  });
  const thread = await twin.ensureOrderThread({ merchantId, orderId });

  const canonicalData = new InMemoryCanonicalDataClient();
  canonicalData.seedCapability({
    capabilityId,
    merchantId,
    kind: "TRANSFORM",
    name: capabilityId,
    description: capabilityId,
    accepts: [],
    produces: [],
    quantity: { min: 1, max: 100, unit: "units" },
    pricing: { currency: "CAD", unitPrice: 4.5, setupFee: 0 },
    leadTime: { min: 24, max: 48, unit: "hours" },
    capacity: { available: capacityAvailable, maximum: 100, period: "day" },
    hardRules: [],
    softRules: [],
    sourceClaimIds: [],
  });

  const capacity = new InMemoryCapacityStore();
  capacity.seedCapacity(merchantId, capabilityId, capacityAvailable);
  const jobs = new InMemoryJobDecisionStore();
  const modelRouter = createModelRouter(adapter);

  const quote = createQuoteService({
    adapter,
    twin,
    repository,
    tools: { canonicalData, capacity, jobs },
    modelRouter,
    council,
  });

  return {
    adapter,
    repository,
    quote,
    threadId: thread.threadId,
    capacity,
    modelRouter,
  };
}

function quoteJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    setupFee: 0,
    currency: "CAD",
    confidence: 0.9,
    explanation: "ok",
    ...overrides,
  });
}

describe("createQuoteService", () => {
  it("returns a non-binding CAN_ACCEPT and leaves capacity untouched when hold is false", async () => {
    const { adapter, quote, threadId, capacity } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-1",
    });

    adapter.programThread(threadId, [
      {
        type: "final",
        text: quoteJson({
          merchantId: "stitchworks",
          capabilityId: "embroidery",
          status: "CAN_ACCEPT",
          unitPrice: 4.5,
        }),
      },
    ]);

    const response = await quote.handleQuoteRequest({
      orderId: "order-1",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 10,
      currency: "CAD",
      hold: false,
    });

    expect(response.status).toBe("CAN_ACCEPT");
    expect(response.reservationId).toBeUndefined();
    await expect(
      capacity.getAvailableCapacity("stitchworks", "embroidery"),
    ).resolves.toBe(20);
  });

  it("reserves capacity when hold is true and the merchant can accept", async () => {
    const { adapter, quote, threadId, capacity } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-2",
    });

    adapter.programThread(threadId, [
      {
        type: "final",
        text: quoteJson({
          merchantId: "stitchworks",
          capabilityId: "embroidery",
          status: "CAN_ACCEPT",
          unitPrice: 4.5,
        }),
      },
    ]);

    const response = await quote.handleQuoteRequest({
      orderId: "order-2",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 5,
      currency: "CAD",
      hold: true,
    });

    expect(response.status).toBe("CAN_ACCEPT");
    expect(response.reservationId).toBeDefined();
    await expect(
      capacity.getAvailableCapacity("stitchworks", "embroidery"),
    ).resolves.toBe(15);
  });

  it("quotes three merchant twins concurrently without cross-merchant interference", async () => {
    const merchantIds = ["basegoods", "stitchworks", "laserlab"];
    const harnesses = await Promise.all(
      merchantIds.map((merchantId) =>
        setupMerchant({ merchantId, capabilityId: "cap", orderId: "order-3" }),
      ),
    );

    harnesses.forEach((harness, index) => {
      harness.adapter.programThread(harness.threadId, [
        {
          type: "final",
          text: quoteJson({
            merchantId: merchantIds[index],
            capabilityId: "cap",
            status: "CAN_ACCEPT",
          }),
        },
      ]);
    });

    const responses = await Promise.all(
      harnesses.map((harness, index) =>
        harness.quote.handleQuoteRequest({
          orderId: "order-3",
          traceId,
          merchantId: merchantIds[index],
          capabilityId: "cap",
          quantity: 5,
          currency: "CAD",
        }),
      ),
    );

    responses.forEach((response, index) => {
      expect(response.status).toBe("CAN_ACCEPT");
      expect(response.merchantId).toBe(merchantIds[index]);
    });
  });

  it("declines because persistent merchant memory records a rush-quantity limit", async () => {
    const { adapter, repository, quote, threadId } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-4",
      boundaries: [
        "Never auto-accept rush embroidery above 40 units while machine #2 is down.",
      ],
    });

    const assistant = await repository.getAssistant("stitchworks");
    await adapter.recordMerchantMemory({
      merchantId: "stitchworks",
      assistantId: assistant!.assistantId,
      note: "Never auto-accept rush embroidery above 40 units while machine #2 is down.",
    });

    adapter.programThread(threadId, [
      {
        type: "final",
        text: quoteJson({
          merchantId: "stitchworks",
          capabilityId: "embroidery",
          status: "DECLINE",
          explanation:
            "Rush quantity 55 exceeds the remembered 40-unit limit while machine #2 is down.",
        }),
      },
    ]);

    const response = await quote.handleQuoteRequest({
      orderId: "order-4",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 55,
      currency: "CAD",
    });

    expect(response.status).toBe("DECLINE");
    expect(response.explanation).toMatch(/40-unit limit/);
  });

  /**
   * B5 items 71-73: the previous test proves the *outcome* the mock was
   * scripted to return; it would still pass even if the quote service never
   * looked at memory at all. This test proves the *wiring* — that memory
   * recorded on one order thread is actually recalled and placed in the
   * message sent on a later, different order thread for the same merchant.
   */
  it("recalls cross-thread merchant memory and includes the sanitized note in the message sent for a new order", async () => {
    const { adapter, repository, quote, threadId } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-a",
    });

    const assistant = await repository.getAssistant("stitchworks");
    const recorded = await adapter.recordMerchantMemory({
      merchantId: "stitchworks",
      assistantId: assistant!.assistantId,
      note: "Never auto-accept rush embroidery above 40 units while machine #2 is down.",
      sourceThreadId: threadId,
    });

    // A different order for the same merchant gets its own thread.
    const secondThread = await repository.getThread("stitchworks", "order-b");
    expect(secondThread).toBeUndefined();

    // The service creates order-b's thread itself and we don't know its ID
    // ahead of time, so sendWithTools is mocked directly rather than
    // programmed via adapter.programThread(threadId, ...).
    const spy = vi.spyOn(adapter, "sendWithTools");
    spy.mockResolvedValueOnce({
      outcome: "COMPLETED",
      text: "ok",
      data: {
        merchantId: "stitchworks",
        capabilityId: "embroidery",
        status: "DECLINE",
        setupFee: 0,
        currency: "CAD",
        requiredChanges: [],
        confidence: 0.9,
        explanation: "Exceeds the remembered rush limit.",
      },
      toolCalls: [],
    });

    await quote.handleQuoteRequest({
      orderId: "order-b",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 55,
      currency: "CAD",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const sentInput = spy.mock.calls[0]![0];
    expect(sentInput.threadId).not.toBe(threadId);
    expect(sentInput.message).toContain(recorded.note);
    expect(sentInput.message).toContain("Remembered merchant policy");
    // Bounded by live capacity: the message still directs the model to a
    // live tool rather than letting the remembered note stand in for it.
    expect(sentInput.message).toContain("calculate_quote");
  });

  it("repairs once after malformed output and returns the corrected quote", async () => {
    const { adapter, quote } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-5",
    });

    const spy = vi.spyOn(adapter, "sendWithTools");
    spy.mockResolvedValueOnce({
      outcome: "FALLBACK",
      reason: "MALFORMED_OUTPUT",
      text: "not json",
      toolCalls: [],
    });
    spy.mockResolvedValueOnce({
      outcome: "COMPLETED",
      text: "ok",
      data: {
        merchantId: "stitchworks",
        capabilityId: "embroidery",
        status: "CAN_ACCEPT",
        setupFee: 0,
        currency: "CAD",
        requiredChanges: [],
        confidence: 0.9,
        explanation: "repaired",
      },
      toolCalls: [],
    });

    const response = await quote.handleQuoteRequest({
      orderId: "order-5",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 5,
      currency: "CAD",
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(response.status).toBe("CAN_ACCEPT");
    expect(response.explanation).toBe("repaired");
  });

  it("throws QuoteProtocolError when the repair attempt also fails to validate", async () => {
    const { adapter, quote } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-6",
    });

    const spy = vi.spyOn(adapter, "sendWithTools");
    spy.mockResolvedValue({
      outcome: "FALLBACK",
      reason: "MALFORMED_OUTPUT",
      text: "still not json",
      toolCalls: [],
    });

    await expect(
      quote.handleQuoteRequest({
        orderId: "order-6",
        traceId,
        merchantId: "stitchworks",
        capabilityId: "embroidery",
        quantity: 5,
        currency: "CAD",
      }),
    ).rejects.toBeInstanceOf(QuoteProtocolError);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("treats a COUNTEROFFER with no structured requiredChanges as incomplete and repairs it once", async () => {
    const { adapter, quote } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-7",
    });

    const spy = vi.spyOn(adapter, "sendWithTools");
    spy.mockResolvedValueOnce({
      outcome: "COMPLETED",
      text: "vague",
      data: {
        merchantId: "stitchworks",
        capabilityId: "embroidery",
        status: "COUNTEROFFER",
        setupFee: 0,
        currency: "CAD",
        requiredChanges: [],
        confidence: 0.8,
        explanation: "We could maybe do fewer units, not sure.",
      },
      toolCalls: [],
    });
    spy.mockResolvedValueOnce({
      outcome: "COMPLETED",
      text: "structured",
      data: {
        merchantId: "stitchworks",
        capabilityId: "embroidery",
        status: "COUNTEROFFER",
        setupFee: 0,
        currency: "CAD",
        requiredChanges: [
          { operation: "replace", path: "quantity", value: 30 },
        ],
        confidence: 0.85,
        explanation: "Can only accept 30 units by the deadline.",
      },
      toolCalls: [],
    });

    const response = await quote.handleQuoteRequest({
      orderId: "order-7",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 55,
      currency: "CAD",
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(response.status).toBe("COUNTEROFFER");
    expect(response.requiredChanges).toHaveLength(1);
  });

  it("surfaces a non-malformed fallback (timeout) as unavailable rather than retrying", async () => {
    const { adapter, quote } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-8",
    });

    const spy = vi.spyOn(adapter, "sendWithTools");
    spy.mockResolvedValue({
      outcome: "FALLBACK",
      reason: "TIMEOUT",
      text: "timed out",
      toolCalls: [],
    });

    await expect(
      quote.handleQuoteRequest({
        orderId: "order-8",
        traceId,
        merchantId: "stitchworks",
        capabilityId: "embroidery",
        quantity: 5,
        currency: "CAD",
      }),
    ).rejects.toBeInstanceOf(MerchantQuoteUnavailableError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("downgrades to DECLINE when a held quote loses a capacity race after the model said CAN_ACCEPT", async () => {
    const { adapter, quote, threadId, capacity } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-9",
      capacityAvailable: 5,
    });

    // A concurrent hold consumes the remaining capacity between the model's
    // stale read and this handler's own reservation attempt.
    await capacity.reserve({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-other",
      quantity: 5,
      actionKey: "other-hold",
    });

    adapter.programThread(threadId, [
      {
        type: "final",
        text: quoteJson({
          merchantId: "stitchworks",
          capabilityId: "embroidery",
          status: "CAN_ACCEPT",
          explanation: "Stale view before the race",
        }),
      },
    ]);

    const response = await quote.handleQuoteRequest({
      orderId: "order-9",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 3,
      currency: "CAD",
      hold: true,
    });

    expect(response.status).toBe("DECLINE");
    expect(response.reservationId).toBeUndefined();
  });

  it("rejects a request for a merchant with no provisioned Backboard assistant", async () => {
    const { quote } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-10",
    });

    await expect(
      quote.handleQuoteRequest({
        orderId: "order-10",
        traceId,
        merchantId: "unknown-merchant",
        capabilityId: "embroidery",
        quantity: 5,
        currency: "CAD",
      }),
    ).rejects.toThrow(/no backboard assistant/i);
  });

  /**
   * B6 items 75-78: at least two distinct lanes get used across the demo's
   * quote traffic, and switching lanes never creates a second assistant or
   * thread for the same merchant/order — model routing only changes which
   * model a run uses, not merchant/order identity.
   */
  it("routes a firm-hold deadline quote to HIGH_REASONING and a plain quote to FAST_OPS without losing assistant/thread identity", async () => {
    const { adapter, repository, quote, threadId } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-fast",
    });

    adapter.programThread(threadId, [
      {
        type: "final",
        text: quoteJson({
          merchantId: "stitchworks",
          capabilityId: "embroidery",
          status: "CAN_ACCEPT",
        }),
      },
    ]);

    const spy = vi.spyOn(adapter, "sendWithTools");

    await quote.handleQuoteRequest({
      orderId: "order-fast",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 5,
      currency: "CAD",
    });

    const deadlineThread = await repository.getThread(
      "stitchworks",
      "order-deadline",
    );
    expect(deadlineThread).toBeUndefined();

    // The service creates order-deadline's thread itself, so sendWithTools
    // is mocked directly rather than pre-programmed via a known threadId.
    spy.mockResolvedValueOnce({
      outcome: "COMPLETED",
      text: "ok",
      data: {
        merchantId: "stitchworks",
        capabilityId: "embroidery",
        status: "CAN_ACCEPT",
        setupFee: 0,
        currency: "CAD",
        requiredChanges: [],
        confidence: 0.95,
        explanation: "Deadline guaranteed.",
      },
      toolCalls: [],
    });

    await quote.handleQuoteRequest({
      orderId: "order-deadline",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 5,
      currency: "CAD",
      deadline: "2026-12-01T00:00:00.000Z",
      hold: true,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    const [fastCall, deadlineCall] = spy.mock.calls.map((call) => call[0]);

    expect(fastCall!.model).toBe("mock-fast-1");
    expect(deadlineCall!.model).toBe("mock-reasoning-1");
    expect(fastCall!.model).not.toBe(deadlineCall!.model);

    // Same merchant assistant used both times; only the thread differs
    // because these are two different orders, not because the lane changed.
    expect(fastCall!.assistantId).toBe(deadlineCall!.assistantId);
    expect(fastCall!.threadId).not.toBe(deadlineCall!.threadId);

    const assistant = await repository.getAssistant("stitchworks");
    expect(fastCall!.assistantId).toBe(assistant!.assistantId);
  });

  it("keeps the exact same thread when the same order's quote later qualifies for a different lane", async () => {
    const { adapter, quote, threadId } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-same",
    });

    const spy = vi.spyOn(adapter, "sendWithTools");
    spy.mockResolvedValue({
      outcome: "COMPLETED",
      text: "ok",
      data: {
        merchantId: "stitchworks",
        capabilityId: "embroidery",
        status: "CAN_ACCEPT",
        setupFee: 0,
        currency: "CAD",
        requiredChanges: [],
        confidence: 0.9,
        explanation: "ok",
      },
      toolCalls: [],
    });

    await quote.handleQuoteRequest({
      orderId: "order-same",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 5,
      currency: "CAD",
    });
    await quote.handleQuoteRequest({
      orderId: "order-same",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 5,
      currency: "CAD",
      deadline: "2026-12-01T00:00:00.000Z",
      hold: true,
    });

    const [first, second] = spy.mock.calls.map((call) => call[0]);
    expect(first!.model).toBe("mock-fast-1");
    expect(second!.model).toBe("mock-reasoning-1");
    expect(first!.threadId).toBe(threadId);
    expect(second!.threadId).toBe(threadId);
  });
});

/**
 * B7 items 79-81: the optional merchant council. Acceptance criterion:
 * "Council can be disabled with a feature flag without changing quote API."
 */
describe("createQuoteService merchant council", () => {
  it("does not run the council when disabled (the default), even for a deadline-guarantee request", async () => {
    const { adapter, quote, threadId } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-council-off",
    });

    adapter.programThread(threadId, [
      {
        type: "final",
        text: quoteJson({
          merchantId: "stitchworks",
          capabilityId: "embroidery",
          status: "CAN_ACCEPT",
        }),
      },
    ]);
    const spy = vi.spyOn(adapter, "sendWithTools");

    const response = await quote.handleQuoteRequest({
      orderId: "order-council-off",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 5,
      currency: "CAD",
      hold: true,
      deadline: "2026-12-01T00:00:00.000Z",
    });

    expect(response.status).toBe("CAN_ACCEPT");
    // Only the quote call itself — no council perspective calls.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("runs the council out-of-band for a deadline-guarantee request when enabled, without changing the returned QuoteResponse", async () => {
    let captured: RecommendationSet | undefined;
    const { adapter, quote, threadId } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-council-on",
      council: {
        enabled: true,
        onRecommendation: (recommendationSet) => {
          captured = recommendationSet;
        },
      },
    });

    adapter.programThread(threadId, [
      {
        type: "final",
        text: quoteJson({
          merchantId: "stitchworks",
          capabilityId: "embroidery",
          status: "CAN_ACCEPT",
        }),
      },
    ]);

    const response = await quote.handleQuoteRequest({
      orderId: "order-council-on",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 5,
      currency: "CAD",
      hold: true,
      deadline: "2026-12-01T00:00:00.000Z",
    });

    // The quote API response is exactly the QuoteResponse shape either way —
    // no recommendation data leaks into it.
    expect(response.status).toBe("CAN_ACCEPT");
    expect(response).not.toHaveProperty("recommendations");
    expect(response).not.toHaveProperty("council");

    expect(captured).toBeDefined();
    expect(captured!.orderId).toBe("order-council-on");
    expect(captured!.scenario).toBe("deadline_guarantee");
    expect(captured!.recommendations).toHaveLength(3);
    expect(
      new Set(captured!.recommendations.map((r) => r.perspective)),
    ).toEqual(new Set(["operations", "risk", "contract"]));
  });

  it("never runs the council for a non-deadline-guarantee request even when enabled", async () => {
    let called = false;
    const { adapter, quote, threadId } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-council-fastops",
      council: {
        enabled: true,
        onRecommendation: () => {
          called = true;
        },
      },
    });

    adapter.programThread(threadId, [
      {
        type: "final",
        text: quoteJson({
          merchantId: "stitchworks",
          capabilityId: "embroidery",
          status: "CAN_ACCEPT",
        }),
      },
    ]);

    await quote.handleQuoteRequest({
      orderId: "order-council-fastops",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 5,
      currency: "CAD",
    });

    expect(called).toBe(false);
  });

  it("swallows a council failure so it never surfaces as a quote error", async () => {
    const { adapter, quote, threadId } = await setupMerchant({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      orderId: "order-council-fail",
      council: { enabled: true },
    });

    const quoteResponseText = quoteJson({
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      status: "CAN_ACCEPT",
    });
    adapter.programThread(threadId, [
      { type: "final", text: quoteResponseText },
    ]);

    const realSendWithTools = adapter.sendWithTools.bind(adapter);
    vi.spyOn(adapter, "sendWithTools").mockImplementation(async (rawInput) => {
      const input = rawInput as { message: string };
      if (input.message.includes("perspective:")) {
        throw new Error("council provider outage");
      }
      return realSendWithTools(rawInput as never);
    });

    const response = await quote.handleQuoteRequest({
      orderId: "order-council-fail",
      traceId,
      merchantId: "stitchworks",
      capabilityId: "embroidery",
      quantity: 5,
      currency: "CAD",
      hold: true,
      deadline: "2026-12-01T00:00:00.000Z",
    });

    expect(response.status).toBe("CAN_ACCEPT");
  });
});
