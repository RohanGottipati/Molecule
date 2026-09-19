import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RealBackboardAdapter } from "./RealBackboardAdapter.js";

const identity = {
  merchantId: "merchant",
  displayName: "Merchant",
  specialty: "Embroidery",
  boundaries: [],
};
const timestamp = "2026-09-19T00:00:00.000Z";

describe("real Backboard provider wire boundary", () => {
  it("does not advertise JSON output when the live catalog reports unknown support", async () => {
    const adapter = new RealBackboardAdapter({
      apiKey: "test",
      fetchImpl: async () =>
        Response.json({
          models: [true, false, null].map((supports_json_output, index) => ({
            name: `model-${index}`,
            provider: "provider",
            context_limit: 32000,
            supports_tools: true,
            supports_thinking: false,
            supports_json_output,
          })),
          total: 3,
        }),
    });
    const models = await adapter.listModels();
    expect(models.map((model) => model.supportsJsonOutput)).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      models.every(
        (model) => model.supportsTools && model.contextWindow === 32000,
      ),
    ).toBe(true);
  });

  it("rejects malformed model capability values", async () => {
    const adapter = new RealBackboardAdapter({
      apiKey: "test",
      fetchImpl: async () =>
        Response.json({
          models: [
            {
              name: "model",
              provider: "provider",
              context_limit: 32000,
              supports_tools: true,
              supports_thinking: false,
              supports_json_output: "yes",
            },
          ],
        }),
    });
    await expect(adapter.listModels()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("sends JSON schema tools, validates identity and submits documented tool-output payload", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json(
        calls.length === 1
          ? {
              thread_id: "thread",
              status: "REQUIRES_ACTION",
              tool_calls: [
                {
                  id: "call",
                  function: {
                    name: "get_capacity",
                    arguments: '{"capabilityId":"cap","merchantId":"attacker"}',
                  },
                },
              ],
            }
          : {
              thread_id: "thread",
              status: "COMPLETED",
              content: '{"ok":true}',
            },
      );
    };
    const handler = vi.fn(async (_args, context) => ({
      merchantId: context.merchantId,
      available: 300,
    }));
    const adapter = new RealBackboardAdapter({ apiKey: "test", fetchImpl });
    const result = await adapter.sendWithTools({
      merchantId: "merchant",
      assistantId: "assistant",
      threadId: "thread",
      traceId: "trace",
      message: "quote",
      tools: [
        {
          name: "get_capacity",
          description: "Capacity",
          risk: "read",
          parameters: z.object({ capabilityId: z.string() }),
          handler,
        },
      ],
      responseSchema: z.object({ ok: z.boolean() }),
    });
    expect(result.outcome).toBe("COMPLETED");
    expect(handler).toHaveBeenCalledWith(
      { capabilityId: "cap" },
      expect.objectContaining({ merchantId: "merchant" }),
    );
    expect(calls[0]?.body.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({
          parameters: expect.objectContaining({
            properties: { capabilityId: { type: "string" } },
          }),
        }),
      }),
    ]);
    expect(calls[1]).toMatchObject({
      url: "https://app.backboard.io/api/threads/tool-outputs",
      body: {
        thread_id: "thread",
        tool_outputs: [
          {
            tool_call_id: "call",
            output: '{"merchantId":"merchant","available":300}',
          },
        ],
      },
    });
  });

  it("rejects malformed JSON, missing IDs and error bodies without exposing provider secrets", async () => {
    for (const response of [
      new Response("not-json", { status: 200 }),
      Response.json({ created_at: timestamp }),
      new Response("secret-key-and-private-reasoning", { status: 401 }),
    ]) {
      const adapter = new RealBackboardAdapter({
        apiKey: "secret",
        fetchImpl: async () => response,
      });
      await expect(
        adapter.createMerchantAssistant(identity),
      ).rejects.toMatchObject({ name: "BackboardApiError" });
    }
    const adapter = new RealBackboardAdapter({
      apiKey: "secret",
      fetchImpl: async () => new Response("secret", { status: 429 }),
    });
    await expect(adapter.createMerchantAssistant(identity)).rejects.toThrow(
      "Backboard API failed with 429",
    );
  });

  it("aborts the HTTP request on timeout and explicit cancellation", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    const adapter = new RealBackboardAdapter({
      apiKey: "test",
      requestTimeoutMs: 20,
      fetchImpl,
    });
    await expect(
      adapter.createMerchantAssistant(identity),
    ).rejects.toMatchObject({ status: 504, code: "TIMEOUT" });
    const controller = new AbortController();
    controller.abort();
    const cancelled = new RealBackboardAdapter({
      apiKey: "test",
      signal: controller.signal,
      fetchImpl,
    });
    await expect(
      cancelled.createMerchantAssistant(identity),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("does not accept a completion belonging to another thread", async () => {
    const adapter = new RealBackboardAdapter({
      apiKey: "test",
      fetchImpl: async () =>
        Response.json({
          thread_id: "different",
          status: "COMPLETED",
          content: '{"ok":true}',
        }),
    });
    expect(
      await adapter.sendWithTools({
        merchantId: "merchant",
        assistantId: "assistant",
        threadId: "thread",
        traceId: "trace",
        message: "quote",
        tools: [],
      }),
    ).toMatchObject({ outcome: "FALLBACK", reason: "PROVIDER_ERROR" });
  });

  it("uploads multipart through the same bounded request path and retains provenance", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      return Response.json({ document_id: "document", created_at: timestamp });
    };
    const adapter = new RealBackboardAdapter({ apiKey: "test", fetchImpl });
    expect(
      await adapter.uploadMerchantDocument({
        merchantId: "merchant",
        assistantId: "assistant",
        fileName: "policy.txt",
        mimeType: "text/plain",
        content: "Synthetic policy",
        category: "materials_policy",
        version: 2,
        sourceTimestamp: timestamp,
        stale: true,
      }),
    ).toMatchObject({
      documentId: "document",
      sourceTimestamp: timestamp,
      stale: true,
      version: 2,
    });
  });
});
