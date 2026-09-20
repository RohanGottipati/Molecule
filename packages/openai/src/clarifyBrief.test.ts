import { composeClarifiedBrief } from "@molecule/contracts";
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import {
  clarificationCompileRequest,
  deadlineOptions,
  withSuggestedOptions,
} from "./clarifyBrief.js";
import { MockOpenAIAdapter } from "./MockOpenAIAdapter.js";
import { RealOpenAIAdapter } from "./RealOpenAIAdapter.js";

const base = {
  locale: "en-CA",
  timeZone: "America/Toronto",
  requestedAt: "2026-09-20T12:00:00.000Z",
  assets: [],
};

describe("clarifyBrief (mock adapter)", () => {
  const adapter = new MockOpenAIAdapter();

  it("returns CLEAR for a complete brief", async () => {
    await expect(
      adapter.clarifyBrief({
        ...base,
        text: "Make 20 hoodies by 2026-10-01 CAD",
      }),
    ).resolves.toEqual({ status: "CLEAR" });
  });

  it("asks structured questions with deterministic options for missing facts", async () => {
    const result = await adapter.clarifyBrief({
      ...base,
      text: "Make hoodies with embroidered logo",
    });
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    const byField = new Map(result.questions.map((q) => [q.field, q]));
    expect([...byField.keys()]).toEqual(
      expect.arrayContaining(["quantity", "deadline", "currency"]),
    );
    expect(byField.get("quantity")?.options.map((o) => o.value)).toEqual([
      "25",
      "50",
      "100",
      "250",
    ]);
    expect(byField.get("currency")?.options.map((o) => o.value)).toEqual([
      "CAD",
      "USD",
    ]);
    const deadline = byField.get("deadline")!;
    expect(deadline.options).toHaveLength(4);
    expect(deadline.options[0]).toMatchObject({
      label: "In 2 weeks",
      value: "2026-10-04",
    });
    for (const question of result.questions) {
      expect(question.allowCustom).toBe(true);
      expect(question.questionId).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
    }
    expect(result.summary).toMatch(/3 details/);
  });

  it("offers model-style suggestions for product and device questions", async () => {
    const product = await adapter.clarifyBrief({
      ...base,
      text: "We need 40 units by 2026-11-01 in CAD",
    });
    expect(product.status).toBe("NEEDS_INPUT");
    if (product.status !== "NEEDS_INPUT") return;
    const productQuestion = product.questions.find(
      (q) => q.question === "What product should be made?",
    );
    expect(productQuestion?.options.length).toBeGreaterThan(0);

    const device = await adapter.clarifyBrief({
      ...base,
      text: "Make 40 phone cases by 2026-11-01 in CAD",
    });
    expect(device.status).toBe("NEEDS_INPUT");
    if (device.status !== "NEEDS_INPUT") return;
    expect(device.questions).toHaveLength(1);
    expect(device.questions[0]).toMatchObject({
      field: "phone case.deviceModel",
      question: "Which phone model must the case fit?",
    });
    expect(device.questions[0]!.options.map((o) => o.value)).toContain(
      "iPhone 16 Pro",
    );
  });

  it("resolves the brief once answers are appended", async () => {
    const first = await adapter.clarifyBrief({
      ...base,
      text: "Make hoodies with embroidered logo",
    });
    if (first.status !== "NEEDS_INPUT") throw new Error("expected questions");
    const clarified = composeClarifiedBrief(
      "Make hoodies with embroidered logo",
      first.questions.map((question) => ({
        questionId: question.questionId,
        question: question.question,
        answer: question.options[1]?.value ?? "n/a",
      })),
    );
    await expect(
      adapter.clarifyBrief({ ...base, text: clarified }),
    ).resolves.toEqual({ status: "CLEAR" });

    const compiled = await adapter.compileIntent({
      ...clarificationCompileRequest({ ...base, text: clarified }),
    });
    expect(compiled.status).toBe("READY");
    if (compiled.status !== "READY") return;
    expect(compiled.intent.quantity).toBe(50);
    expect(compiled.intent.currency).toBe("USD");
    expect(compiled.intent.deadline.slice(0, 10)).toBe("2026-10-18");
  });

  it("does not loop on mock-only ambiguity once the customer has answered it", async () => {
    const text = "Make 30 hoodies by 2026-11-01 CAD, glow in the dark";
    const first = await adapter.clarifyBrief({ ...base, text });
    if (first.status !== "NEEDS_INPUT") throw new Error("expected questions");
    expect(first.questions[0]!.question).toMatch(/glow in the dark/);
    const clarified = composeClarifiedBrief(text, [
      {
        question: first.questions[0]!.question,
        answer: "The hoodie print should use glow-in-the-dark ink",
      },
    ]);
    await expect(
      adapter.clarifyBrief({ ...base, text: clarified }),
    ).resolves.toEqual({ status: "CLEAR" });
  });

  it("passes through unsupported briefs", async () => {
    const result = await adapter.clarifyBrief({
      ...base,
      text: "Tell me a joke about pandas",
    });
    expect(["UNSUPPORTED", "NEEDS_INPUT"]).toContain(result.status);
  });

  it("uses a preflight trace and keeps the caller's order id when present", () => {
    const fresh = clarificationCompileRequest({ ...base, text: "hoodies" });
    expect(fresh.orderId).toMatch(/^preflight-/);
    expect(fresh.traceId).toMatch(/^clarify-/);
    const existing = clarificationCompileRequest({
      ...base,
      text: "hoodies",
      orderId: "order-1",
    });
    expect(existing.orderId).toBe("order-1");
  });
});

describe("deadlineOptions", () => {
  it("anchors on the requester's calendar day", () => {
    const options = deadlineOptions(
      "2026-09-20T03:30:00.000Z",
      "America/Vancouver",
      "en-CA",
    );
    expect(options.map((o) => o.value)).toEqual([
      "2026-10-03",
      "2026-10-17",
      "2026-10-31",
      "2026-10-31",
    ]);
  });

  it("falls back to UTC for an invalid time zone", () => {
    expect(
      deadlineOptions("2026-09-20T12:00:00.000Z", "Mars/Olympus", "en-CA")[0],
    ).toMatchObject({ value: "2026-10-04" });
  });
});

describe("withSuggestedOptions", () => {
  it("only fills questions that have no deterministic options", () => {
    const result = withSuggestedOptions(
      {
        status: "NEEDS_INPUT",
        questions: [
          {
            questionId: "a",
            field: "currency",
            question: "CAD or USD?",
            options: [{ label: "CAD", value: "CAD" }],
            allowCustom: true,
          },
          {
            questionId: "b",
            field: "hoodie.colour",
            question: "Which colour?",
            options: [],
            allowCustom: true,
          },
        ],
      },
      [
        { question: "CAD or USD?", options: [{ label: "EUR", value: "EUR" }] },
        {
          question: "which colour?",
          options: [
            { label: "Black", value: "black" },
            { label: "Black", value: "BLACK" },
            { label: "Navy", value: "navy" },
          ],
          inputHint: "Any colour name",
        },
      ],
    );
    if (result.status !== "NEEDS_INPUT") throw new Error("expected questions");
    expect(result.questions[0]!.options.map((o) => o.value)).toEqual(["CAD"]);
    expect(result.questions[1]!.options.map((o) => o.value)).toEqual([
      "black",
      "navy",
    ]);
    expect(result.questions[1]!.inputHint).toBe("Any colour name");
  });
});

describe("clarifyBrief (real adapter)", () => {
  const extraction = {
    outcome: "NEEDS_CLARIFICATION",
    unsupportedReason: null,
    quantity: 40,
    deadline: "2026-11-01T23:59:59.000Z",
    currency: "CAD",
    budgetMax: null,
    desiredOutputs: [
      {
        key: "hoodie",
        name: "Hoodie",
        quantity: 40,
        attributes: [{ name: "product", value: "hoodie" }],
      },
    ],
    transformations: [],
    hardConstraints: [],
    softPreferences: [],
    ambiguityFlags: [
      {
        field: "hoodie.colour",
        reason: "Colour was not specified",
        question: "Which colour should the hoodies be?",
      },
    ],
  };

  it("asks the model for options on open questions and merges them", async () => {
    const parse = vi
      .fn()
      .mockResolvedValueOnce({
        status: "completed",
        output_parsed: extraction,
        output: [],
      })
      .mockResolvedValueOnce({
        status: "completed",
        output_parsed: {
          questions: [
            {
              question: "Which colour should the hoodies be?",
              options: [
                { label: "Black", value: "Black hoodies", hint: null },
                {
                  label: "Heather grey",
                  value: "Heather grey hoodies",
                  hint: null,
                },
              ],
              inputHint: null,
            },
          ],
        },
        output: [],
      });
    const client = { responses: { parse } } as unknown as OpenAI;
    const adapter = new RealOpenAIAdapter({ apiKey: "test-only", client });
    const result = await adapter.clarifyBrief({
      ...base,
      text: "Make 40 hoodies by 2026-11-01 CAD",
    });
    expect(parse).toHaveBeenCalledTimes(2);
    const suggestionCall = JSON.stringify(parse.mock.calls[1]);
    expect(suggestionCall).toContain("clarification_options");
    expect(suggestionCall).not.toContain("test-only");
    expect(result).toMatchObject({
      status: "NEEDS_INPUT",
      questions: [
        {
          field: "hoodie.colour",
          question: "Which colour should the hoodies be?",
          options: [
            { label: "Black", value: "Black hoodies" },
            { label: "Heather grey", value: "Heather grey hoodies" },
          ],
        },
      ],
    });
  });

  it("degrades to free-text questions when the suggestion pass fails", async () => {
    const parse = vi
      .fn()
      .mockResolvedValueOnce({
        status: "completed",
        output_parsed: extraction,
        output: [],
      })
      .mockRejectedValueOnce(new OpenAI.APIConnectionError({}));
    const client = { responses: { parse } } as unknown as OpenAI;
    const adapter = new RealOpenAIAdapter({ apiKey: "test-only", client });
    const result = await adapter.clarifyBrief({
      ...base,
      text: "Make 40 hoodies by 2026-11-01 CAD",
    });
    expect(result).toMatchObject({
      status: "NEEDS_INPUT",
      questions: [{ field: "hoodie.colour", options: [] }],
    });
  });

  it("skips the suggestion pass when every question already has options", async () => {
    const parse = vi.fn().mockResolvedValueOnce({
      status: "completed",
      output_parsed: {
        ...extraction,
        quantity: null,
        ambiguityFlags: [
          {
            field: "quantity",
            reason: "missing",
            question: "How many hoodies do you need?",
          },
        ],
      },
      output: [],
    });
    const client = { responses: { parse } } as unknown as OpenAI;
    const adapter = new RealOpenAIAdapter({ apiKey: "test-only", client });
    const result = await adapter.clarifyBrief({
      ...base,
      text: "Make hoodies by 2026-11-01 CAD",
    });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "NEEDS_INPUT",
      questions: [{ field: "quantity", options: [{ value: "40" }] }],
    });
  });
});
