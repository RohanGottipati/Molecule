// Interpretation of ONE stated capacity figure. Pure: no database, no model, no
// clock. The rule that shapes everything here (Order 2 uncertainty policy) is
// that a value we cannot support from the source is sent to review with a
// reason - it is never rounded into shape.
//
//   * A quantity with no stated period is not a per-day rate. It might be an
//     absolute batch slot.
//   * "up to", "at least", ranges and "subject to confirmation" stay qualified;
//     they are never replaced by the bound, the midpoint or an unqualified number.
//   * An hourly rate cannot become a daily one without stated operating hours.
//   * A stated window that has already ended, or has not started, does not
//     establish current capacity.
//
// Weekly and monthly rates keep the frozen pro-rata calendar convention the
// evaluator uses (7 and 30 days); the conversion is always listed in `applied`.

import { parseNumber } from "./numbers.mjs";

export const CAPACITY_POLICIES = ["strict", "legacy"];
export const PERIOD_DAYS = { day: 1, week: 7, month: 30 };

// Strict patterns are used on free text around the number: a bare "day" there
// is not a rate ("400 units in 2 days" is a batch, not 400/day).
const STRICT = {
  hour: /\b(?:per|an?|every|each)\s+hour\b|\/\s*(?:hours?|hrs?|h)\b|\bhourly\b/i,
  day: /\b(?:per|an?|every|each)\s+day\b|\/\s*(?:day|d)\b|\bdaily\b/i,
  week: /\b(?:per|an?|every|each)\s+week\b|\/\s*(?:week|wk|w)\b|\bweekly\b/i,
  month: /\b(?:per|an?|every|each)\s+month\b|\/\s*(?:month|mo)\b|\bmonthly\b/i,
};
// Loose patterns are used on fields that are unit or period words by contract.
const LOOSE = {
  hour: /\b(?:hours?|hrs?|hourly)\b/i,
  day: /\b(?:days?|daily)\b/i,
  week: /\b(?:weeks?|weekly|wk)\b/i,
  month: /\b(?:months?|monthly)\b/i,
};

const detect = (text, patterns) =>
  Object.entries(patterns)
    .filter(([, re]) => re.test(text))
    .map(([period]) => period);

const norm = (s) => String(s ?? "").replace(/\s+/g, " ");

/** Text immediately before and after the stated value inside its evidence. */
export function surroundings(evidence, valueText) {
  const ev = norm(evidence);
  const needle = norm(valueText).trim();
  if (!ev || !needle) return { located: false, before: ev, after: ev };
  const i = ev.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return { located: false, before: ev, after: ev };
  // The sentence holding the number: a caveat elsewhere in the message ("prices
  // are tentative") is not a caveat on this figure.
  let start = 0;
  for (const m of ev.slice(0, i).matchAll(/[.!?;](?=\s)|\n/g))
    start = m.index + m[0].length;
  const tail = ev.slice(i + needle.length);
  const stop = tail.search(/[.!?;](?=\s|$)|\n/);
  const end = stop < 0 ? ev.length : i + needle.length + stop + 1;
  return {
    located: true,
    before: ev.slice(Math.max(0, i - 40), i),
    after: ev.slice(i + needle.length, i + needle.length + 50),
    wide: ev.slice(start, end),
  };
}

const BEFORE = {
  upper_bound:
    /(?:\b(?:up\s+to|max(?:imum)?(?:\s+of)?|at\s+most|no\s+more\s+than|not\s+more\s+than|capped\s+at|limited\s+to)|<=?|≤)\s*[$~]?\s*$/i,
  lower_bound:
    /(?:\b(?:at\s+least|min(?:imum)?(?:\s+of)?|no\s+less\s+than|more\s+than|over|upwards\s+of)|>=?|≥)\s*[$~]?\s*$/i,
  approximate:
    /(?:\b(?:about|approx\.?|approximately|around|roughly|circa|c\.|nearly|almost)|~)\s*$/i,
};
const AFTER = {
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

/** Every qualifier the wording (or the extractor) attaches to the number. */
export function detectQualifiers({ value, evidence, qualifier }) {
  const text = norm(value);
  const found = new Set();
  const modelQualifier = String(qualifier ?? "").trim();
  if (modelQualifier) found.add(modelQualifier);
  if (RANGE_IN_VALUE.test(text)) found.add("range");
  if (/\d\s*\+\s*$/.test(text)) found.add("lower_bound");
  const near = surroundings(evidence, text);
  const before = norm(near.before).trimEnd();
  const after = norm(near.after);
  const valueLead = text.toLowerCase();
  for (const kind of Object.keys(BEFORE)) {
    if (BEFORE[kind].test(before)) found.add(kind);
    if (near.located && AFTER[kind].test(after)) found.add(kind);
  }
  // The value string itself may carry the qualifier ("up to 400").
  for (const kind of Object.keys(BEFORE)) {
    const lead = valueLead.match(/^(\D+)\d/);
    if (lead && BEFORE[kind].test(lead[1])) found.add(kind);
  }
  if (near.located) {
    if (RANGE_AFTER.test(after) || RANGE_BEFORE.test(before))
      found.add("range");
    if (CONDITIONAL.test(near.wide)) found.add("conditional");
  } else if (CONDITIONAL.test(norm(evidence))) {
    found.add("conditional");
  }
  return [...found];
}

const NOT_PROMOTABLE = {
  conditional: "is conditional (subject to confirmation)",
  range: "is a range, not a single figure",
  upper_bound: "is an upper bound (up to / at most), not a stated capacity",
  lower_bound: "is a lower bound (at least / more than), not a stated capacity",
};

/** Which single rate period the source states, or why it cannot be decided. */
export function resolvePeriod({ unit, period, evidence, value }) {
  const direct = new Set([
    ...detect(String(period ?? ""), LOOSE),
    ...detect(String(unit ?? ""), LOOSE),
  ]);
  const near = surroundings(evidence, value);
  const afterPeriods = detect(near.after, STRICT);
  const beforePeriods = detect(near.before.slice(-25), STRICT);
  const contextual =
    afterPeriods.length > 0
      ? afterPeriods
      : beforePeriods.length > 0
        ? beforePeriods
        : [];
  if (direct.size > 1)
    return { status: "conflict", periods: [...direct], source: "fields" };
  if (direct.size === 1) {
    const only = [...direct][0];
    // A period the extractor reported must agree with what the text next to the
    // number says, when the text says anything.
    if (contextual.length && !contextual.includes(only))
      return {
        status: "conflict",
        periods: [only, ...contextual],
        source: "fields-vs-text",
      };
    return {
      status: "stated",
      period: only,
      source: "fields",
      textSupported: contextual.includes(only),
    };
  }
  if (contextual.length === 1)
    return {
      status: "stated",
      period: contextual[0],
      source: "text",
      textSupported: true,
    };
  if (contextual.length > 1)
    return { status: "conflict", periods: contextual, source: "text" };
  return { status: "missing" };
}

function windowProblem({ effectiveFrom, effectiveUntil, observedAt }) {
  const from = effectiveFrom ? Date.parse(effectiveFrom) : NaN;
  const until = effectiveUntil ? Date.parse(effectiveUntil) : NaN;
  const seen = observedAt ? Date.parse(observedAt) : NaN;
  if (Number.isFinite(from) && Number.isFinite(until) && until < from)
    return {
      code: "window_inverted",
      reason: "Effective window ends before it starts",
    };
  if (Number.isFinite(seen)) {
    if (Number.isFinite(until) && until < seen)
      return {
        code: "window_expired",
        reason: `Stated window ended (${effectiveUntil}) before the document was written; it does not establish current capacity`,
      };
    if (Number.isFinite(from) && from > seen)
      return {
        code: "window_future",
        reason: `Stated window starts later (${effectiveFrom}) than the document date; it does not establish current capacity`,
      };
  }
  return null;
}

// The extractor's own note says this figure revises an earlier one. A revision
// does not necessarily keep the earlier figure's period ("143 a day" ... "actually
// 750"), so a period that only the extractor's fields supply is not evidence.
const REVISION =
  /\b(?:revis(?:ed|es|ion|ing)|correct(?:ed|ion|s|ing)|supersed(?:es|ed)|updat(?:ed|es|ing)\s+(?:from|to)|earlier|previous(?:ly)?|replaces?)\b/i;

const review = (code, reason, extra = {}) => ({
  ok: false,
  disposition: "needs_review",
  code,
  reason,
  ...extra,
});

/**
 * @param {object} input value/unit/period/evidence as the extractor reported them,
 *   optional ambiguity (the extractor's note on the figure),
 *   optional qualifier ("approximate"|"upper_bound"|"lower_bound"|"range"|"conditional"),
 *   effectiveFrom/effectiveUntil (ISO strings) and observedAt (document date).
 */
export function interpretCapacity(input) {
  const { value, unit, period, evidence, qualifier } = input;
  const text = norm(value).trim();
  const qualifiers = detectQualifiers({ value: text, evidence, qualifier });

  for (const kind of ["conditional", "range", "upper_bound", "lower_bound"])
    if (qualifiers.includes(kind))
      return review(
        kind,
        `Capacity "${text.slice(0, 40)}" ${NOT_PROMOTABLE[kind]}; needs a human decision, not a number`,
        { qualifiers },
      );

  const n = parseNumber(text.replace(/\s*\+\s*$/, ""));
  if (n === null)
    return {
      ok: false,
      disposition: "quarantine",
      code: "unreadable",
      reason: `Value "${text.slice(0, 40)}" is not a number we can read`,
    };
  if (n < 0)
    return {
      ok: false,
      disposition: "quarantine",
      code: "negative",
      reason: "Negative value is not meaningful for this field",
    };

  const applied = [];
  if (qualifiers.includes("approximate"))
    applied.push("qualified: approximate (figure kept as stated)");

  // Zero capacity means none, whatever the period.
  if (n === 0) {
    applied.push("zero capacity is period-independent");
    return {
      ok: true,
      value: 0,
      unit: "units/day",
      applied,
      statedPeriod: null,
      qualifiers,
    };
  }

  const resolved = resolvePeriod({ unit, period, evidence, value: text });
  if (resolved.status === "conflict")
    return review(
      "period_conflict",
      `Conflicting capacity periods (${resolved.periods.join(", ")}); the source does not pin down one`,
      { qualifiers },
    );
  if (resolved.status === "missing") {
    const near = surroundings(evidence, text);
    const absolute = ABSOLUTE.test(near.located ? near.wide : norm(evidence));
    return review(
      absolute ? "absolute_batch" : "no_period",
      absolute
        ? "Quantity looks like a one-off batch or slot, not a rate; not converted to units/day"
        : "Capacity stated without a period; it may be an absolute batch, so it is not assumed per-day",
      { qualifiers },
    );
  }
  const p = resolved.period;
  if (!resolved.textSupported && REVISION.test(input.ambiguity ?? ""))
    return review(
      "period_inherited",
      "The figure revises an earlier one and its own text states no period; the period was carried over, not stated",
      { qualifiers, statedPeriod: p },
    );
  if (p === "hour")
    return review(
      "hourly_rate",
      "Hourly rate cannot become units/day without stated operating hours per day",
      { qualifiers, statedPeriod: p },
    );

  const problem = windowProblem(input);
  if (problem) return review(problem.code, problem.reason, { qualifiers });

  const days = PERIOD_DAYS[p];
  if (p !== "day")
    applied.push(`${p} -> day (pro-rata over ${days} calendar days)`);
  if (input.effectiveFrom || input.effectiveUntil)
    applied.push(
      `effective ${input.effectiveFrom || "?"} to ${input.effectiveUntil || "?"}`,
    );
  return {
    ok: true,
    value: Math.round((n / days) * 100) / 100,
    unit: "units/day",
    applied,
    statedPeriod: p,
    stated: { value: n, period: p },
    qualifiers,
  };
}
