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
});
