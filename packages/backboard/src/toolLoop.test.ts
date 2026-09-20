import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { BackboardApiError } from "./BackboardAdapter.js";
import { MockBackboardAdapter } from "./MockBackboardAdapter.js";
import { runBoundedToolLoop } from "./toolLoop.js";
import type { ToolDefinition } from "./types.js";

const traceId = "trace-1";
const merchantId = "merchant-1";

function baseInput(
  threadId: string,
  assistantId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    merchantId,
    assistantId,
    threadId,
    traceId,
    message: "hello",
    orderId: "order-1",
    tools: [] as ToolDefinition[],
    ...overrides,
  };
}

describe("bounded tool-call loop", () => {
  it("validates completion after the last allowed tool round without executing another round", async () => {
    const handler = vi.fn(async () => ({ available: 4 }));
    const client = {
      start: async () => ({
        status: "requires_action",
        toolCalls: [{ id: "call", name: "capacity", args: {} }],
      }),
      submitToolOutputs: vi.fn(async () => ({
        status: "completed",
        text: '{"available":4}',
      })),
    };
    const input = {
      client,
      message: "quote",
      tools: [
        {
          name: "capacity",
          description: "Capacity",
          risk: "read" as const,
          parameters: z.object({}),
          handler,
        },
      ],
      context: { merchantId, threadId: "thread", traceId },
      responseSchema: z.object({ available: z.number() }),
      maxRounds: 1,
    };
    expect(await runBoundedToolLoop(input)).toMatchObject({
      outcome: "COMPLETED",
      data: { available: 4 },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    client.submitToolOutputs.mockResolvedValueOnce({
      status: "completed",
      text: "invalid",
    });
    expect(await runBoundedToolLoop(input)).toMatchObject({
      outcome: "FALLBACK",
      reason: "MALFORMED_OUTPUT",
    });
  });

  it.each(["TIMEOUT", "ABORTED"] as const)(
    "preserves provider %s as timeout",
    async (code) => {
      expect(
        await runBoundedToolLoop({
          client: {
            start: async () => {
              throw new BackboardApiError("bounded", 504, code);
            },
            submitToolOutputs: vi.fn(),
          },
          message: "quote",
          tools: [],
          context: { merchantId, threadId: "thread", traceId },
        }),
      ).toMatchObject({ outcome: "FALLBACK", reason: "TIMEOUT" });
    },
  );

  it("completes directly when the model returns a final answer with no tool calls", async () => {
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "Acme",
      specialty: "printing",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    adapter.programThread(thread.threadId, [
      { type: "final", text: "all good" },
    ]);

    const result = await adapter.sendWithTools(
      baseInput(thread.threadId, assistant.assistantId),
    );

    expect(result.outcome).toBe("COMPLETED");
    if (result.outcome === "COMPLETED") {
      expect(result.text).toBe("all good");
      expect(result.toolCalls).toHaveLength(0);
    }
  });

  it("executes a read tool and feeds its result back before completing", async () => {
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "Acme",
      specialty: "printing",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    adapter.programThread(thread.threadId, [
      { type: "tool_call", name: "get_capacity", args: { line: "embroidery" } },
      { type: "final", text: "capacity checked" },
    ]);

    const capacityTool: ToolDefinition = {
      name: "get_capacity",
      description: "Reads live capacity",
      risk: "read",
      parameters: z.object({ line: z.string() }),
      handler: async () => ({ available: 42 }),
    };

    const result = await adapter.sendWithTools(
      baseInput(thread.threadId, assistant.assistantId, {
        tools: [capacityTool],
      }),
    );

    expect(result.outcome).toBe("COMPLETED");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.result).toEqual({ available: 42 });
  });

  it("rejects a mutating tool call missing orderId/traceId server context", async () => {
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "Acme",
      specialty: "printing",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    adapter.programThread(thread.threadId, [
      { type: "tool_call", name: "reserve_capacity", args: { units: 5 } },
    ]);

    const reserveTool: ToolDefinition = {
      name: "reserve_capacity",
      description: "Reserves capacity",
      risk: "mutating",
      parameters: z.object({ units: z.number() }),
      handler: async () => ({ reservationId: "res-1" }),
      actionKeyFor: (args, context) =>
        `reserve:${context.orderId}:${args.units}`,
    };

    const result = await adapter.sendWithTools(
      baseInput(thread.threadId, assistant.assistantId, {
        tools: [reserveTool],
        orderId: undefined,
      }),
    );

    expect(result.outcome).toBe("FALLBACK");
    if (result.outcome === "FALLBACK") {
      expect(result.reason).toBe("TOOL_GUARD_REJECTED");
    }
  });

  it("allows a mutating tool call when server context supplies traceId/orderId and a deterministic actionKey", async () => {
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "Acme",
      specialty: "printing",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    adapter.programThread(thread.threadId, [
      { type: "tool_call", name: "reserve_capacity", args: { units: 5 } },
      { type: "final", text: "reserved" },
    ]);

    let receivedActionKey: string | undefined;
    const reserveTool: ToolDefinition = {
      name: "reserve_capacity",
      description: "Reserves capacity",
      risk: "mutating",
      parameters: z.object({ units: z.number() }),
      handler: async (_args, context) => {
        receivedActionKey = context.actionKey;
        return { reservationId: "res-1" };
      },
      actionKeyFor: (args, context) =>
        `reserve:${context.orderId}:${args.units}`,
    };

    const result = await adapter.sendWithTools(
      baseInput(thread.threadId, assistant.assistantId, {
        tools: [reserveTool],
      }),
    );

    expect(result.outcome).toBe("COMPLETED");
    expect(receivedActionKey).toBe("reserve:order-1:5");
  });

  it("falls back deterministically on a malformed provider turn", async () => {
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "Acme",
      specialty: "printing",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    adapter.programThread(thread.threadId, [{ type: "malformed" }]);

    const result = await adapter.sendWithTools(
      baseInput(thread.threadId, assistant.assistantId),
    );

    expect(result.outcome).toBe("FALLBACK");
    if (result.outcome === "FALLBACK") {
      expect(result.reason).toBe("MALFORMED_OUTPUT");
    }
  });

  it("falls back deterministically when the provider hangs past the round timeout", async () => {
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "Acme",
      specialty: "printing",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    adapter.programThread(thread.threadId, [{ type: "hang" }]);

    const result = await adapter.sendWithTools(
      baseInput(thread.threadId, assistant.assistantId, { roundTimeoutMs: 20 }),
    );

    expect(result.outcome).toBe("FALLBACK");
    if (result.outcome === "FALLBACK") {
      expect(result.reason).toBe("TIMEOUT");
    }
  });

  it("stops after maxRounds if the provider never completes", async () => {
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "Acme",
      specialty: "printing",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    const readTool: ToolDefinition = {
      name: "noop",
      description: "does nothing",
      risk: "read",
      parameters: z.object({}),
      handler: async () => ({}),
    };
    adapter.programThread(
      thread.threadId,
      Array.from({ length: 10 }, () => ({
        type: "tool_call" as const,
        name: "noop",
        args: {},
      })),
    );

    const result = await adapter.sendWithTools(
      baseInput(thread.threadId, assistant.assistantId, {
        tools: [readTool],
        maxRounds: 2,
      }),
    );

    expect(result.outcome).toBe("FALLBACK");
    if (result.outcome === "FALLBACK") {
      expect(result.reason).toBe("MAX_ROUNDS_EXCEEDED");
    }
  });

  it("validates the final answer against a response schema and falls back when it does not match", async () => {
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "Acme",
      specialty: "printing",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    adapter.programThread(thread.threadId, [
      { type: "final", text: "not json" },
    ]);

    const schema = z.object({ status: z.enum(["CAN_ACCEPT", "DECLINE"]) });
    const result = await adapter.sendWithTools(
      baseInput(thread.threadId, assistant.assistantId, {
        responseSchema: schema,
      }),
    );

    expect(result.outcome).toBe("FALLBACK");
    if (result.outcome === "FALLBACK") {
      expect(result.reason).toBe("MALFORMED_OUTPUT");
    }
  });

  it("parses a well-formed final answer through the provided response schema", async () => {
    const adapter = new MockBackboardAdapter();
    const assistant = await adapter.createMerchantAssistant({
      merchantId,
      displayName: "Acme",
      specialty: "printing",
      boundaries: [],
    });
    const thread = await adapter.createOrReuseOrderThread({
      merchantId,
      assistantId: assistant.assistantId,
      orderId: "order-1",
    });
    adapter.programThread(thread.threadId, [
      { type: "final", text: JSON.stringify({ status: "CAN_ACCEPT" }) },
    ]);

    const schema = z.object({ status: z.enum(["CAN_ACCEPT", "DECLINE"]) });
    const result = await adapter.sendWithTools(
      baseInput(thread.threadId, assistant.assistantId, {
        responseSchema: schema,
      }),
    );

    expect(result.outcome).toBe("COMPLETED");
    if (result.outcome === "COMPLETED") {
      expect(result.data).toEqual({ status: "CAN_ACCEPT" });
    }
  });
});
