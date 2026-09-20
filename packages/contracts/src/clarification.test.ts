import { describe, expect, it } from "vitest";

import {
  BriefClarificationResultSchema,
  ClarificationQuestionSchema,
  composeClarifiedBrief,
  splitClarifiedBrief,
} from "./index.js";

describe("clarified brief composition", () => {
  it("appends answers without rewriting the customer text", () => {
    const composed = composeClarifiedBrief("Make hoodies with our logo", [
      { question: "How many units do you need?", answer: "50" },
      { question: "Should the order be priced in CAD or USD?", answer: "CAD" },
    ]);
    expect(composed).toBe(
      [
        "Make hoodies with our logo",
        "",
        "Clarifications:",
        "- Q: How many units do you need? A: 50",
        "- Q: Should the order be priced in CAD or USD? A: CAD",
      ].join("\n"),
    );
    expect(splitClarifiedBrief(composed)).toEqual({
      brief: "Make hoodies with our logo",
      answers: [
        { question: "How many units do you need?", answer: "50" },
        {
          question: "Should the order be priced in CAD or USD?",
          answer: "CAD",
        },
      ],
    });
  });

  it("replaces earlier answers to the same question across rounds", () => {
    const first = composeClarifiedBrief("Make hoodies", [
      { question: "How many units do you need?", answer: "50" },
    ]);
    const second = composeClarifiedBrief(first, [
      { question: "How many units do you need?", answer: "75" },
      {
        question: "What is the required delivery deadline?",
        answer: "2026-11-01",
      },
    ]);
    expect(splitClarifiedBrief(second)).toEqual({
      brief: "Make hoodies",
      answers: [
        { question: "How many units do you need?", answer: "75" },
        {
          question: "What is the required delivery deadline?",
          answer: "2026-11-01",
        },
      ],
    });
  });

  it("ignores blank answers and collapses multi-line input", () => {
    expect(
      composeClarifiedBrief("Make hoodies", [
        { question: "How many units do you need?", answer: "   " },
        { question: "Which colour?", answer: "navy\nblue" },
      ]),
    ).toBe("Make hoodies\n\nClarifications:\n- Q: Which colour? A: navy blue");
  });

  it("returns the untouched brief when there is no clarification block", () => {
    expect(splitClarifiedBrief("Make 20 hoodies by 2026-10-01 CAD")).toEqual({
      brief: "Make 20 hoodies by 2026-10-01 CAD",
      answers: [],
    });
  });
});

describe("clarification contracts", () => {
  it("defaults question options and custom input", () => {
    expect(
      ClarificationQuestionSchema.parse({
        questionId: "quantity",
        field: "quantity",
        question: "How many units do you need?",
      }),
    ).toEqual({
      questionId: "quantity",
      field: "quantity",
      question: "How many units do you need?",
      options: [],
      allowCustom: true,
    });
  });

  it("requires at least one question when input is needed", () => {
    expect(
      BriefClarificationResultSchema.safeParse({
        status: "NEEDS_INPUT",
        questions: [],
      }).success,
    ).toBe(false);
    expect(
      BriefClarificationResultSchema.safeParse({ status: "CLEAR" }).success,
    ).toBe(true);
  });
});
