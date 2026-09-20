import { createHash } from "node:crypto";

import {
  BriefClarificationResultSchema,
  ClarificationQuestionSchema,
  type BriefClarificationRequest,
  type BriefClarificationResult,
  type ClarificationOption,
  type ClarificationQuestion,
  type CompileIntentRequest,
  type CompileIntentResult,
  type ProductIntentDraft,
} from "@molecule/contracts";

export const MAX_CLARIFICATION_QUESTIONS = 8;
export const MAX_CLARIFICATION_OPTIONS = 6;

export type SuggestedOptions = {
  question: string;
  options: ClarificationOption[];
  inputHint?: string;
}[];

/** Clarification runs the same compiler the orchestrator uses, under a preflight trace. */
export function clarificationCompileRequest(
  input: BriefClarificationRequest,
): CompileIntentRequest {
  const { orderId, ...rest } = input;
  const digest = createHash("sha256")
    .update(`${orderId ?? "new"}\u0000${input.text}`)
    .digest("hex")
    .slice(0, 24);
  return {
    ...rest,
    orderId: orderId ?? `preflight-${digest}`,
    traceId: `clarify-${digest}`,
  };
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60);

export function clarificationQuestionId(field: string, question: string) {
  const hash = createHash("sha256")
    .update(`${field}\u0000${question}`)
    .digest("hex")
    .slice(0, 8);
  return `${slug(field) || "field"}-${hash}`;
}

function localCalendarDate(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(read("year"), read("month") - 1, read("day")));
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function humanDate(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function deadlineOptions(
  requestedAt: string,
  timeZone: string,
  locale: string,
): ClarificationOption[] {
  let base: Date;
  try {
    base = localCalendarDate(new Date(requestedAt), timeZone);
  } catch {
    base = localCalendarDate(new Date(requestedAt), "UTC");
  }
  if (Number.isNaN(base.getTime())) return [];
  const safeLocale = (() => {
    try {
      new Intl.DateTimeFormat(locale);
      return locale;
    } catch {
      return "en-CA";
    }
  })();
  const inWeeks = (weeks: number) => {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() + weeks * 7);
    return date;
  };
  const endOfNextMonth = new Date(base);
  endOfNextMonth.setUTCMonth(endOfNextMonth.getUTCMonth() + 2, 0);
  return [
    ...[2, 4, 6].map((weeks) => {
      const date = inWeeks(weeks);
      return {
        label: `In ${weeks} weeks`,
        value: isoDate(date),
        hint: humanDate(date, safeLocale),
      };
    }),
    {
      label: "End of next month",
      value: isoDate(endOfNextMonth),
      hint: humanDate(endOfNextMonth, safeLocale),
    },
  ];
}

export function quantityOptions(
  draft: ProductIntentDraft | undefined,
): ClarificationOption[] {
  const known = [
    ...new Set(
      (draft?.desiredOutputs ?? [])
        .map((output) => output.quantity)
        .filter((value): value is number => typeof value === "number"),
    ),
  ];
  const tiers = known.length ? known : [25, 50, 100, 250];
  return tiers.slice(0, 4).map((count) => ({
    label: `${count.toLocaleString("en-CA")} units`,
    value: String(count),
  }));
}

export const currencyOptions: ClarificationOption[] = [
  { label: "CAD", value: "CAD", hint: "Canadian dollars" },
  { label: "USD", value: "USD", hint: "US dollars" },
];

const fieldKind = (field: string) => {
  const leaf = field.split(".").at(-1)?.toLowerCase() ?? "";
  if (leaf === "quantity") return "quantity";
  if (leaf === "deadline") return "deadline";
  if (leaf === "currency") return "currency";
  if (leaf === "budgetmax" || leaf === "budget") return "budget";
  return "other";
};

/** Options the system can offer without asking a model: they are choices, never facts. */
export function deterministicOptions(
  field: string,
  question: string,
  request: BriefClarificationRequest,
  draft: ProductIntentDraft | undefined,
): { options: ClarificationOption[]; inputHint?: string } {
  const lower = question.toLowerCase();
  const kind = fieldKind(field);
  if (kind === "currency" || /\bcad\b.*\busd\b|\busd\b.*\bcad\b/.test(lower))
    return { options: currencyOptions, inputHint: "Choose one currency" };
  if (kind === "deadline" || /\b(?:deadline|delivery date|due)\b/.test(lower))
    return {
      options: deadlineOptions(
        request.requestedAt,
        request.timeZone,
        request.locale,
      ),
      inputHint: "Pick a date or type one (e.g. 2026-11-15)",
    };
  if (kind === "quantity" || /\bhow many\b/.test(lower))
    return {
      options: quantityOptions(draft),
      inputHint: "Pick a tier or type an exact count",
    };
  if (kind === "budget")
    return { options: [], inputHint: "Maximum total budget, e.g. 2500" };
  return { options: [] };
}

function dedupeOptions(options: ClarificationOption[]) {
  const seen = new Set<string>();
  return options
    .filter((option) => {
      const key = option.value.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_CLARIFICATION_OPTIONS);
}

/** Turn a compiler result into structured questions with deterministic options. */
export function clarificationFromCompile(
  result: CompileIntentResult,
  request: BriefClarificationRequest,
): BriefClarificationResult {
  if (result.status === "READY")
    return BriefClarificationResultSchema.parse({ status: "CLEAR" });
  if (result.status === "UNSUPPORTED")
    return BriefClarificationResultSchema.parse({
      status: "UNSUPPORTED",
      reason: result.reason,
    });
  const byQuestion = new Map<string, ClarificationQuestion>();
  const flags = result.draft.ambiguityFlags.filter(
    (flag): flag is typeof flag & { question: string } =>
      typeof flag.question === "string" && flag.question.trim().length > 0,
  );
  for (const flag of flags) {
    const question = flag.question.trim();
    if (byQuestion.has(question)) continue;
    const derived = deterministicOptions(
      flag.field,
      question,
      request,
      result.draft,
    );
    byQuestion.set(
      question,
      ClarificationQuestionSchema.parse({
        questionId: clarificationQuestionId(flag.field, question),
        field: flag.field,
        question,
        reason: flag.reason?.slice(0, 600),
        options: derived.options,
        allowCustom: true,
        ...(derived.inputHint ? { inputHint: derived.inputHint } : {}),
      }),
    );
  }
  for (const question of result.questions) {
    if (byQuestion.has(question)) continue;
    const derived = deterministicOptions(
      "intent",
      question,
      request,
      result.draft,
    );
    byQuestion.set(
      question,
      ClarificationQuestionSchema.parse({
        questionId: clarificationQuestionId("intent", question),
        field: "intent",
        question,
        options: derived.options,
        allowCustom: true,
        ...(derived.inputHint ? { inputHint: derived.inputHint } : {}),
      }),
    );
  }
  const questions = [...byQuestion.values()].slice(
    0,
    MAX_CLARIFICATION_QUESTIONS,
  );
  return BriefClarificationResultSchema.parse({
    status: "NEEDS_INPUT",
    questions,
    summary:
      questions.length === 1
        ? "One detail needs confirming before Molecule starts planning."
        : `${questions.length} details need confirming before Molecule starts planning.`,
  });
}

/** Fill in model-proposed options only where no deterministic options exist. */
export function withSuggestedOptions(
  result: BriefClarificationResult,
  suggestions: SuggestedOptions,
): BriefClarificationResult {
  if (result.status !== "NEEDS_INPUT") return result;
  const normalized = new Map(
    suggestions.map((item) => [item.question.trim().toLowerCase(), item]),
  );
  return BriefClarificationResultSchema.parse({
    ...result,
    questions: result.questions.map((question, index) => {
      const match =
        normalized.get(question.question.trim().toLowerCase()) ??
        (suggestions[index]?.question.trim().toLowerCase() ===
        question.question.trim().toLowerCase()
          ? suggestions[index]
          : undefined);
      if (!match) return question;
      if (question.options.length > 0) return question;
      return {
        ...question,
        options: dedupeOptions(match.options),
        ...(question.inputHint || !match.inputHint
          ? {}
          : { inputHint: match.inputHint.slice(0, 160) }),
      };
    }),
  });
}
