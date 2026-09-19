import { describe, expect, it, vi } from "vitest";

import { createMerchantCouncil } from "./council.js";
import { createMerchantTwinService } from "./merchantTwin.js";
import { MockBackboardAdapter } from "./MockBackboardAdapter.js";
import { InMemoryMerchantAgentRepository } from "./repository.js";
import type {
  MerchantIdentity,
  SendWithToolsInput,
  SendWithToolsResult,
  ToolDefinition,
} from "./types.js";

const merchant: MerchantIdentity = {
  merchantId: "stitchworks",
  displayName: "Stitchworks",
  specialty: "embroidery",
  boundaries: [],
};

const noTools: ToolDefinition[] = [];

function perspectiveOf(message: string): "operations" | "risk" | "contract" {
  if (message.includes("Operations perspective")) return "operations";
  if (message.includes("Risk perspective")) return "risk";
  return "contract";
}

function completed(
  data: Record<string, unknown>,
): SendWithToolsResult<unknown> {
  return { outcome: "COMPLETED", text: "ok", data, toolCalls: [] };
}

describe("createMerchantCouncil", () => {
  it("runs all three fixed perspectives independently and returns one recommendation each", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);
    const assistant = await twin.ensureAssistant(merchant);

    const responsesByPerspective: Record<string, Record<string, unknown>> = {
      operations: {
        position: "APPROVE",
        rationale: "Live capacity covers this deadline.",
        conditions: [],
        confidence: 0.9,
      },
      risk: {
        position: "APPROVE_WITH_CONDITIONS",
        rationale: "Some risk while machine #2 is down.",
        conditions: ["Confirm machine #2 status before promising."],
        confidence: 0.6,
      },
      contract: {
        position: "REJECT",
        rationale: "Penalty clause too costly if missed.",
        conditions: [],
        confidence: 0.7,
      },
    };

    const sendSpy = vi.spyOn(adapter, "sendWithTools");
    sendSpy.mockImplementation(async (input: SendWithToolsInput) =>
      completed(responsesByPerspective[perspectiveOf(input.message)]!),
    );

    const council = createMerchantCouncil(adapter, noTools);
    const recommendationSet = await council.runCouncil({
      merchantId: merchant.merchantId,
      assistantId: assistant.assistantId,
      traceId: "trace-1",
      orderId: "order-1",
      scenarioContext: "Deadline in 24h for 200 units.",
    });

    expect(recommendationSet.recommendations).toHaveLength(3);
    const byPerspective = Object.fromEntries(
      recommendationSet.recommendations.map((r) => [r.perspective, r]),
    );
    expect(byPerspective.operations?.position).toBe("APPROVE");
    expect(byPerspective.risk?.position).toBe("APPROVE_WITH_CONDITIONS");
    expect(byPerspective.contract?.position).toBe("REJECT");
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(recommendationSet.scenario).toBe("deadline_guarantee");
  });

  it("gives each perspective its own fresh thread rather than sharing the order's quote thread", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);
    const assistant = await twin.ensureAssistant(merchant);
    const orderThread = await twin.ensureOrderThread({
      merchantId: merchant.merchantId,
      orderId: "order-2",
    });

    const threadSpy = vi.spyOn(adapter, "createOrReuseOrderThread");
    const sendSpy = vi.spyOn(adapter, "sendWithTools");
    sendSpy.mockResolvedValue(
      completed({
        position: "APPROVE",
        rationale: "ok",
        conditions: [],
        confidence: 0.8,
      }),
    );

    const council = createMerchantCouncil(adapter, noTools);
    await council.runCouncil({
      merchantId: merchant.merchantId,
      assistantId: assistant.assistantId,
      traceId: "trace-1",
      orderId: "order-2",
      scenarioContext: "context",
    });

    expect(threadSpy).toHaveBeenCalledTimes(3);
    const usedThreadIds = sendSpy.mock.calls.map((call) => call[0].threadId);
    expect(new Set(usedThreadIds).size).toBe(3);
    expect(usedThreadIds).not.toContain(orderThread.threadId);

    const councilOrderIds = threadSpy.mock.calls
      .map((call) => call[0].orderId)
      .sort();
    expect(councilOrderIds).toEqual([
      "order-2:council:contract",
      "order-2:council:operations",
      "order-2:council:risk",
    ]);
  });

  it("fails one perspective closed (REJECT, zero confidence) instead of retrying it, when its output is malformed", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);
    const assistant = await twin.ensureAssistant(merchant);

    const sendSpy = vi.spyOn(adapter, "sendWithTools");
    sendSpy.mockImplementation(async (input: SendWithToolsInput) => {
      if (perspectiveOf(input.message) === "risk") {
        return {
          outcome: "FALLBACK",
          reason: "MALFORMED_OUTPUT",
          text: "not json",
          toolCalls: [],
        } satisfies SendWithToolsResult<unknown>;
      }
      return completed({
        position: "APPROVE",
        rationale: "ok",
        conditions: [],
        confidence: 0.85,
      });
    });

    const council = createMerchantCouncil(adapter, noTools);
    const recommendationSet = await council.runCouncil({
      merchantId: merchant.merchantId,
      assistantId: assistant.assistantId,
      traceId: "trace-1",
      orderId: "order-3",
      scenarioContext: "context",
    });

    const risk = recommendationSet.recommendations.find(
      (r) => r.perspective === "risk",
    );
    expect(risk?.position).toBe("REJECT");
    expect(risk?.confidence).toBe(0);
    // No repair/retry: exactly one sendWithTools call per perspective.
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });
});
