import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealOpenAIAdapter } from "./RealOpenAIAdapter.js";
import { DESKTOP_VOICE_TOOLS } from "./prompts/desktopVoice.js";

afterEach(() => vi.unstubAllGlobals());
describe("desktop provider adapter", () => {
  it("mints only ephemeral credentials with configured models and bounded high-level tools", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ value: "ek_mock", expires_at: 123 }));
    vi.stubGlobal("fetch", transport);
    const adapter = new RealOpenAIAdapter({
      apiKey: "server-only-test-value",
      realtimeModel: "account-realtime",
      transcriptionModel: "account-transcriber",
    });
    expect(
      await adapter.mintRealtimeClientSecret("trace-hash", "desktop"),
    ).toEqual({ value: "ek_mock", expiresAt: 123 });
    const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body));
    expect(body.session.model).toBe("account-realtime");
    expect(body.session.audio.input.transcription.model).toBe(
      "account-transcriber",
    );
    expect(body.session.audio.input.turn_detection).toMatchObject({
      type: "semantic_vad",
      eagerness: "low",
      interrupt_response: true,
      create_response: false,
    });
    expect(
      body.session.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(DESKTOP_VOICE_TOOLS.map((tool) => tool.name));
    expect(JSON.stringify(body.session.tools)).not.toContain("shopify");
    expect(
      body.session.tools.map((tool: { name: string }) => tool.name),
    ).not.toContain("approve_action");
    expect(JSON.stringify(body)).not.toContain("server-only-test-value");
  });
  it("uploads context through the adapter with a deterministic action key", async () => {
    const create = vi.fn(async () => ({ id: "file-provider" }));
    const client = { files: { create } } as unknown as OpenAI;
    const adapter = new RealOpenAIAdapter({ apiKey: "test-only", client });
    await expect(
      adapter.uploadContext({
        bytes: new TextEncoder().encode("Customer context"),
        name: "brief.txt",
        mimeType: "text/plain",
        traceId: "trace-1",
        actionKey: "upload-1",
      }),
    ).resolves.toBe("file-provider");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "user_data" }),
      { headers: { "Idempotency-Key": "trace-1:upload-1" } },
    );
  });
});
