export const CAPABILITY_MIN_SIMILARITY = 0.25;
export const CAPABILITY_MIN_MARGIN = 0.05;
export const ENTITY_THRESHOLDS = { link: 0.9, review: 0.55 } as const;
export const PERIOD_DAYS = { day: 1, week: 7, month: 30 } as const;

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  hundred: 100,
  thousand: 1000,
};

/** Conservative number parsing shared by every capacity-ingestion boundary. */
export function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let value = String(raw).trim().toLowerCase();
  if (!value) return null;
  const words = value
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (
    words.length &&
    words.every(
      (word) => word in NUMBER_WORDS || word === "a" || word === "and",
    )
  ) {
    let current = 0;
    for (const word of words) {
      if (word === "a") current ||= 1;
      else if (word !== "and") {
        const number = NUMBER_WORDS[word]!;
        current =
          number === 100 || number === 1000
            ? (current || 1) * number
            : current + number;
      }
    }
    return Number.isFinite(current) ? current : null;
  }
  value = value
    .replace(/[$€£]/g, "")
    .replace(/\b(cad|usd|gbp|eur)\b/g, "")
    .replace(
      /^(about|approx\.?|approximately|around|under|over|up to|~)\s*/i,
      "",
    )
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(
      /\s*(units?|pcs?|pieces?|ea|each|kits?|hoodies|bottles|packs?)\b.*$/i,
      "",
    )
    .replace(/\s*(\/|per\s+)?(day|week|month|hour|hours|h)\b.*$/i, "")
    .trim();
  if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const STRICT = {
  hour: /\b(?:per|an?|every|each)\s+hour\b|\/\s*(?:hours?|hrs?|h)\b|\bhourly\b/i,
  day: /\b(?:per|an?|every|each)\s+day\b|\/\s*(?:day|d)\b|\bdaily\b/i,
  week: /\b(?:per|an?|every|each)\s+week\b|\/\s*(?:week|wk|w)\b|\bweekly\b/i,
  month: /\b(?:per|an?|every|each)\s+month\b|\/\s*(?:month|mo)\b|\bmonthly\b/i,
};
const LOOSE = {
  hour: /\b(?:hours?|hrs?|hourly)\b/i,
  day: /\b(?:days?|daily)\b/i,
  week: /\b(?:weeks?|weekly|wk)\b/i,
  month: /\b(?:months?|monthly)\b/i,
};
const norm = (value: unknown) => String(value ?? "").replace(/\s+/g, " ");
const detect = (text: string, patterns: Record<string, RegExp>) =>
  Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(text))
    .map(([period]) => period);

export function surroundings(evidence: unknown, valueText: unknown) {
  const text = norm(evidence);
  const needle = norm(valueText).trim();
  if (!text || !needle)
    return { located: false, before: text, after: text, wide: text };
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0)
    return { located: false, before: text, after: text, wide: text };
  let start = 0;
  for (const match of text.slice(0, index).matchAll(/[.!?;](?=\s)|\n/g))
    start = (match.index ?? 0) + match[0].length;
  const tail = text.slice(index + needle.length);
  const stop = tail.search(/[.!?;](?=\s|$)|\n/);
  const end = stop < 0 ? text.length : index + needle.length + stop + 1;
  return {
    located: true,
    before: text.slice(Math.max(0, index - 40), index),
    after: text.slice(index + needle.length, index + needle.length + 50),
    wide: text.slice(start, end),
  };
}

const BEFORE: Record<string, RegExp> = {
  upper_bound:
    /(?:\b(?:up\s+to|max(?:imum)?(?:\s+of)?|at\s+most|no\s+more\s+than|not\s+more\s+than|capped\s+at|limited\s+to)|<=?|≤)\s*[$~]?\s*$/i,
  lower_bound:
    /(?:\b(?:at\s+least|min(?:imum)?(?:\s+of)?|no\s+less\s+than|more\s+than|over|upwards\s+of)|>=?|≥)\s*[$~]?\s*$/i,
  approximate:
    /(?:\b(?:about|approx\.?|approximately|around|roughly|circa|c\.|nearly|almost)|~)\s*$/i,
};
const AFTER: Record<string, RegExp> = {
  upper_bound: /\b(?:max(?:imum)?|at\s+most|or\s+less|tops|top\s+end)\b/i,
  lower_bound: /^\+|\b(?:or\s+more|and\s+up|at\s+least)\b/i,
  approximate:
    /\b(?:give\s+or\s+take|or\s+so|more\s+or\s+less|roughly|approximately|approx)\b|^-?ish\b/i,
};
const CONDITIONAL =
  /\b(?:subject\s+to|pending|tentative(?:ly)?|provisional(?:ly)?|to\s+be\s+confirmed|tbc|tbd|contingent|depend(?:s|ing)\s+on|unless|not\s+guaranteed|may\s+change|if\s+available)\b/i;
const RANGE_IN_VALUE = /\d[\d,.]*\s*(?:-|–|—|to)\s*\d/i;
const RANGE_AFTER = /^(?:(?:-|–|—)\d|\s+to\s+\d)/i;
const RANGE_BEFORE = /\d(?:-|–|—)$|\d\s+to\s+$/i;
const ABSOLUTE =
  /\b(?:in\s+total|total\s+of|this\s+(?:order|batch|run|job)|per\s+(?:order|batch|run|job)|one[- ]off|single\s+run|slot)\b/i;
const REVISION =
  /\b(?:revis(?:ed|es|ion|ing)|correct(?:ed|ion|s|ing)|supersed(?:es|ed)|updat(?:ed|es|ing)\s+(?:from|to)|earlier|previous(?:ly)?|replaces?)\b/i;

export interface CapacityInterpretationInput {
  value: unknown;
  unit?: unknown;
  period?: unknown;
  evidence?: unknown;
  qualifier?: unknown;
  effectiveFrom?: string;
  effectiveUntil?: string;
  observedAt?: string;
  ambiguity?: unknown;
}

export function detectQualifiers(
  input: Pick<CapacityInterpretationInput, "value" | "evidence" | "qualifier">,
): string[] {
  const text = norm(input.value);
  const found = new Set<string>();
  const modelQualifier = String(input.qualifier ?? "").trim();
  if (modelQualifier) found.add(modelQualifier);
  if (RANGE_IN_VALUE.test(text)) found.add("range");
  if (/\d\s*\+\s*$/.test(text)) found.add("lower_bound");
  const near = surroundings(input.evidence, text);
  const before = norm(near.before).trimEnd();
  const after = norm(near.after);
  for (const kind of Object.keys(BEFORE)) {
    if (BEFORE[kind]!.test(before)) found.add(kind);
    if (near.located && AFTER[kind]!.test(after)) found.add(kind);
    const lead = text.toLowerCase().match(/^(\D+)\d/);
    if (lead?.[1] && BEFORE[kind]!.test(lead[1])) found.add(kind);
  }
  if (near.located) {
    if (RANGE_AFTER.test(after) || RANGE_BEFORE.test(before))
      found.add("range");
    if (CONDITIONAL.test(near.wide)) found.add("conditional");
  } else if (CONDITIONAL.test(norm(input.evidence))) found.add("conditional");
  return [...found];
}

export function resolvePeriod(
  input: Pick<
    CapacityInterpretationInput,
    "unit" | "period" | "evidence" | "value"
  >,
):
  | { status: "missing" }
  | { status: "conflict"; periods: string[]; source: string }
  | {
      status: "stated";
      period: keyof typeof PERIOD_DAYS | "hour";
      source: string;
      textSupported: boolean;
    } {
  const direct = new Set([
    ...detect(String(input.period ?? ""), LOOSE),
    ...detect(String(input.unit ?? ""), LOOSE),
  ]);
  const near = surroundings(input.evidence, input.value);
  const after = detect(near.after, STRICT);
  const before = detect(near.before.slice(-25), STRICT);
  const contextual = after.length ? after : before;
  if (direct.size > 1)
    return { status: "conflict", periods: [...direct], source: "fields" };
  if (direct.size === 1) {
    const period = [...direct][0]! as keyof typeof PERIOD_DAYS | "hour";
    if (contextual.length && !contextual.includes(period))
      return {
        status: "conflict",
        periods: [period, ...contextual],
        source: "fields-vs-text",
      };
    return {
      status: "stated",
      period,
      source: "fields",
      textSupported: contextual.includes(period),
    };
  }
  if (contextual.length === 1)
    return {
      status: "stated",
      period: contextual[0]! as keyof typeof PERIOD_DAYS | "hour",
      source: "text",
      textSupported: true,
    };
  if (contextual.length > 1)
    return { status: "conflict", periods: contextual, source: "text" };
  return { status: "missing" };
}

const review = (
  code: string,
  reason: string,
  extra: Record<string, unknown> = {},
) => ({
  ok: false as const,
  disposition: "needs_review" as const,
  code,
  reason,
  ...extra,
});

/** Strict interpretation: unsupported assumptions become review, never claims. */
export function interpretCapacity(input: CapacityInterpretationInput) {
  const text = norm(input.value).trim();
  const qualifiers = detectQualifiers(input);
  const descriptions: Record<string, string> = {
    conditional: "is conditional (subject to confirmation)",
    range: "is a range, not a single figure",
    upper_bound: "is an upper bound (up to / at most), not a stated capacity",
    lower_bound:
      "is a lower bound (at least / more than), not a stated capacity",
  };
  for (const kind of ["conditional", "range", "upper_bound", "lower_bound"])
    if (qualifiers.includes(kind))
      return review(
        kind,
        `Capacity "${text.slice(0, 40)}" ${descriptions[kind]}; needs a human decision, not a number`,
        { qualifiers },
      );
  const value = parseNumber(text.replace(/\s*\+\s*$/, ""));
  if (value === null)
    return {
      ok: false as const,
      disposition: "quarantine" as const,
      code: "unreadable",
      reason: `Value "${text.slice(0, 40)}" is not a number we can read`,
    };
  if (value < 0)
    return {
      ok: false as const,
      disposition: "quarantine" as const,
      code: "negative",
      reason: "Negative value is not meaningful for this field",
    };
  const applied: string[] = [];
  if (qualifiers.includes("approximate"))
    applied.push("qualified: approximate (figure kept as stated)");
  if (value === 0)
    return {
      ok: true as const,
      value: 0,
      unit: "units/day",
      applied: [...applied, "zero capacity is period-independent"],
      statedPeriod: null,
      qualifiers,
    };
  const resolved = resolvePeriod(input);
  if (resolved.status === "conflict")
    return review(
      "period_conflict",
      `Conflicting capacity periods (${resolved.periods.join(", ")}); the source does not pin down one`,
      { qualifiers },
    );
  if (resolved.status === "missing") {
    const near = surroundings(input.evidence, text);
    const absolute = ABSOLUTE.test(
      near.located ? near.wide : norm(input.evidence),
    );
    return review(
      absolute ? "absolute_batch" : "no_period",
      absolute
        ? "Quantity looks like a one-off batch or slot, not a rate; not converted to units/day"
        : "Capacity stated without a period; it may be an absolute batch, so it is not assumed per-day",
      { qualifiers },
    );
  }
  if (!resolved.textSupported && REVISION.test(String(input.ambiguity ?? "")))
    return review(
      "period_inherited",
      "The figure revises an earlier one and its own text states no period; the period was carried over, not stated",
      { qualifiers, statedPeriod: resolved.period },
    );
  if (resolved.period === "hour")
    return review(
      "hourly_rate",
      "Hourly rate cannot become units/day without stated operating hours per day",
      { qualifiers, statedPeriod: resolved.period },
    );
  const from = input.effectiveFrom ? Date.parse(input.effectiveFrom) : NaN;
  const until = input.effectiveUntil ? Date.parse(input.effectiveUntil) : NaN;
  const seen = input.observedAt ? Date.parse(input.observedAt) : NaN;
  if (Number.isFinite(from) && Number.isFinite(until) && until < from)
    return review("window_inverted", "Effective window ends before it starts", {
      qualifiers,
    });
  if (Number.isFinite(seen) && Number.isFinite(until) && until < seen)
    return review(
      "window_expired",
      `Stated window ended (${input.effectiveUntil}) before the document was written; it does not establish current capacity`,
      { qualifiers },
    );
  if (Number.isFinite(seen) && Number.isFinite(from) && from > seen)
    return review(
      "window_future",
      `Stated window starts later (${input.effectiveFrom}) than the document date; it does not establish current capacity`,
      { qualifiers },
    );
  const days = PERIOD_DAYS[resolved.period];
  if (resolved.period !== "day")
    applied.push(
      `${resolved.period} -> day (pro-rata over ${days} calendar days)`,
    );
  if (input.effectiveFrom || input.effectiveUntil)
    applied.push(
      `effective ${input.effectiveFrom || "?"} to ${input.effectiveUntil || "?"}`,
    );
  return {
    ok: true as const,
    value: Math.round((value / days) * 100) / 100,
    unit: "units/day",
    applied,
    statedPeriod: resolved.period,
    stated: { value, period: resolved.period },
    qualifiers,
  };
}
