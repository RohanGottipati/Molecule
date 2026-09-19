import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  buildDemoMerchantMemory,
  DEMO_RUSH_LIMIT_MEMORY_NOTE,
} from "./demoMemory.js";
import { MockBackboardAdapter } from "./MockBackboardAdapter.js";
import { InMemoryMerchantAgentRepository } from "./repository.js";
import { createMerchantTwinService } from "./merchantTwin.js";
import type { MerchantIdentity, ToolDefinition } from "./types.js";

const merchant: MerchantIdentity = {
  merchantId: "merchant-1",
  displayName: "Acme Embroidery",
  specialty: "rush embroidery",
  boundaries: [
    "Never auto-accept rush embroidery above 40 units while machine #2 is down.",
  ],
};

/**
 * Definition of done: "A test proves persistent merchant memory can affect a
 * new order while live capacity still comes from a tool." This exercises the
 * full lifecycle across two separate order threads for the same merchant.
 */
describe("persistent memory vs. live capacity", () => {
  it("recalls a memory recorded on one order thread inside a different order thread, without letting it override a fresh live capacity read", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);

    const assistant = await twin.ensureAssistant(merchant);

    // Live capacity is mutable state read only through a tool call, never cached in memory.
    let liveCapacity = 100;
    const capacityTool: ToolDefinition = {
      name: "get_capacity",
      description: "Reads live embroidery capacity",
      risk: "read",
      parameters: z.object({}),
      handler: async () => ({ available: liveCapacity }),
    };

    // Order A: the assistant records a merchant-level correction to memory.
    const threadA = await twin.ensureOrderThread({
      merchantId: merchant.merchantId,
      orderId: "order-a",
    });
    await adapter.recordMerchantMemory({
      merchantId: merchant.merchantId,
      assistantId: assistant.assistantId,
      note: "Never auto-accept rush embroidery above 40 units while machine #2 is down.",
      sourceThreadId: threadA.threadId,
    });

    adapter.programThread(threadA.threadId, [
      { type: "tool_call", name: "get_capacity", args: {} },
      { type: "final", text: "order A handled" },
    ]);
    await adapter.sendWithTools({
      merchantId: merchant.merchantId,
      assistantId: assistant.assistantId,
      threadId: threadA.threadId,
      traceId: "trace-a",
      orderId: "order-a",
      message: "Rush order for 30 units.",
      tools: [capacityTool],
    });

    // Order B: a different thread for the same merchant.
    const threadB = await twin.ensureOrderThread({
      merchantId: merchant.merchantId,
      orderId: "order-b",
    });
    expect(threadB.threadId).not.toBe(threadA.threadId);

    const recalled = await adapter.recallMerchantMemory({
      merchantId: merchant.merchantId,
      assistantId: assistant.assistantId,
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.note).toContain("40 units");
    expect(recalled[0]?.sourceThreadId).toBe(threadA.threadId);

    // Capacity changes between orders; a stale cached value must not leak in.
    liveCapacity = 12;

    adapter.programThread(threadB.threadId, [
      { type: "tool_call", name: "get_capacity", args: {} },
      { type: "final", text: JSON.stringify({ status: "COUNTEROFFER" }) },
    ]);
    const memoryContext = recalled.map((entry) => entry.note).join("\n");
    const result = await adapter.sendWithTools({
      merchantId: merchant.merchantId,
      assistantId: assistant.assistantId,
      threadId: threadB.threadId,
      traceId: "trace-b",
      orderId: "order-b",
      message: `Remembered merchant policy:\n${memoryContext}\n\nRush order for 55 units.`,
      tools: [capacityTool],
      responseSchema: z.object({
        status: z.enum(["CAN_ACCEPT", "COUNTEROFFER", "DECLINE"]),
      }),
    });

    expect(result.outcome).toBe("COMPLETED");
    expect(result.toolCalls).toHaveLength(1);
    // The capacity value surfaced to the loop is the live one read at call time, not order A's.
    expect(result.toolCalls[0]?.result).toEqual({ available: 12 });
    if (result.outcome === "COMPLETED") {
      expect(result.data).toEqual({ status: "COUNTEROFFER" });
    }
  });
});

/**
 * B5 item 71: demo prep seeds the merchant correction once via
 * ensureMerchantMemory, idempotently, exactly like ensureMerchantCorpus.
 */
describe("ensureMerchantMemory", () => {
  it("records each note once and skips it on a repeated call", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);
    await twin.ensureAssistant(merchant);

    const first = await twin.ensureMerchantMemory({
      merchantId: merchant.merchantId,
      notes: buildDemoMerchantMemory(),
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.note).toBe(DEMO_RUSH_LIMIT_MEMORY_NOTE);

    const second = await twin.ensureMerchantMemory({
      merchantId: merchant.merchantId,
      notes: buildDemoMerchantMemory(),
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.memoryId).toBe(first[0]?.memoryId);

    const assistant = await repository.getAssistant(merchant.merchantId);
    const recalled = await adapter.recallMerchantMemory({
      merchantId: merchant.merchantId,
      assistantId: assistant!.assistantId,
    });
    expect(recalled).toHaveLength(1);
  });

  it("refuses to seed memory before an assistant exists for the merchant", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);

    await expect(
      twin.ensureMerchantMemory({
        merchantId: "unknown-merchant",
        notes: buildDemoMerchantMemory(),
      }),
    ).rejects.toThrow(/no backboard assistant/i);
  });
});
