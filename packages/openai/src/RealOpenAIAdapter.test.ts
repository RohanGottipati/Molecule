import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { MoleculeOpenAIError } from "./errors.js";
import { RealOpenAIAdapter } from "./RealOpenAIAdapter.js";

const request = {
  orderId: "order-1",
  traceId: "trace-1",
  text: "Make 10 hoodies by 2026-12-01 CAD",
  locale: "en-CA",
  timeZone: "UTC",
  requestedAt: "2026-09-19T12:00:00.000Z",
  assets: [],
};

describe("RealOpenAIAdapter validation boundary", () => {
  it("classifies connection errors without an HTTP status as retryable transport failures", async () => {
    const client = {
      responses: {
        parse: vi.fn().mockRejectedValue(new OpenAI.APIConnectionError({})),
      },
    } as unknown as OpenAI;
    await expect(
      new RealOpenAIAdapter({ apiKey: "test-only", client }).compileIntent(
        request,
      ),
    ).rejects.toMatchObject({ code: "TRANSPORT", retryable: true });
  });
  it("retries malformed structured output once and never returns it", async () => {
    const parse = vi.fn().mockResolvedValue({
      status: "completed",
      output_parsed: { outcome: "EXTRACTED" },
      output: [],
    });
    const client = { responses: { parse } } as unknown as OpenAI;
    const adapter = new RealOpenAIAdapter({ apiKey: "test-only", client });

    await expect(adapter.compileIntent(request)).rejects.toMatchObject<
      Partial<MoleculeOpenAIError>
    >({ code: "VALIDATION", retryable: false });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(parse.mock.calls[1])).toContain("validationFeedback");
  });

  it("does not retry a model refusal", async () => {
    const parse = vi.fn().mockResolvedValue({
      status: "completed",
      output_parsed: null,
      output: [
        {
          type: "message",
          content: [{ type: "refusal", refusal: "Cannot help" }],
        },
      ],
    });
    const client = { responses: { parse } } as unknown as OpenAI;
    const adapter = new RealOpenAIAdapter({ apiKey: "test-only", client });

    await expect(adapter.compileIntent(request)).rejects.toMatchObject({
      code: "REFUSAL",
    });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("classifies provider 4xx responses as non-retryable validation errors", async () => {
    const providerError = new Error(
      "Invalid response schema",
    ) as OpenAI.APIError;
    Object.setPrototypeOf(providerError, OpenAI.APIError.prototype);
    Object.assign(providerError, {
      status: 400,
      code: "invalid_request",
      error: { type: "invalid_request_error" },
    });
    const client = {
      responses: { parse: vi.fn().mockRejectedValue(providerError) },
    } as unknown as OpenAI;
    const adapter = new RealOpenAIAdapter({ apiKey: "test-only", client });

    await expect(adapter.compileIntent(request)).rejects.toMatchObject({
      code: "VALIDATION",
      retryable: false,
      details: {
        status: 400,
        code: "invalid_request",
        type: "invalid_request_error",
      },
    });
  });

  it("redacts credentials from unexpected provider diagnostics", async () => {
    const client = {
      responses: {
        parse: vi
          .fn()
          .mockRejectedValue(
            new Error("failed with sk-private and ek_private"),
          ),
      },
    } as unknown as OpenAI;
    const adapter = new RealOpenAIAdapter({ apiKey: "test-only", client });

    const error = await adapter.compileIntent(request).catch((cause) => cause);
    expect(error).toMatchObject({
      code: "TRANSPORT",
      details: { message: "failed with [redacted] and [redacted]" },
    });
    expect(JSON.stringify(error)).not.toContain("private");
  });
});
