import assert from "node:assert/strict";
import test from "node:test";
import {
  detectQualifiers,
  interpretCapacity,
  resolvePeriod,
} from "../pipeline/capacity.mjs";

const cap = (o) => interpretCapacity({ unit: "", period: "", ...o });

test("explicit per-day figure is a claim with nothing assumed", () => {
  const r = cap({
    value: "400",
    unit: "units/day",
    evidence: "We do 400 units/day",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 400);
  assert.deepEqual(r.applied, []);
  assert.equal(r.statedPeriod, "day");
});

test("missing period is never assumed per-day", () => {
  for (const evidence of [
    "capacity is 400",
    "we can do about 400",
    "~400 units",
  ]) {
    const r = cap({ value: "400", evidence });
    assert.equal(r.ok, false, evidence);
    assert.equal(r.disposition, "needs_review");
    assert.equal(r.code, "no_period");
  }
});

test("period found in the text beside the number is enough", () => {
  const r = cap({ value: "400", evidence: "we run 400 pieces a day here" });
  assert.equal(r.ok, true);
  assert.equal(r.statedPeriod, "day");
});

test("a batch over several days is not a per-day rate", () => {
  const r = cap({ value: "400", evidence: "400 units in 2 days" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_period");
});

test("one-off batch or slot wording is labelled absolute, not a rate", () => {
  const r = cap({
    value: "200",
    evidence: "we have a slot for 200 in total for this order",
  });
  assert.equal(r.code, "absolute_batch");
});

test("weekly and monthly rates convert pro-rata and say so", () => {
  const w = cap({
    value: "2,800",
    unit: "a week",
    period: "week",
    evidence: "2,800 a week",
  });
  assert.equal(w.value, 400);
  assert.match(w.applied.join(), /week -> day/);
  const m = cap({ value: "3000", period: "month", evidence: "3000 per month" });
  assert.equal(m.value, 100);
});

test("hourly rate needs operating hours; it is not multiplied by a guess", () => {
  const r = cap({ value: "60", unit: "per hour", evidence: "60 per hour" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "hourly_rate");
});

test("ranges are not replaced by a bound or midpoint", () => {
  for (const value of ["300-400", "300 to 400", "300–400"]) {
    const r = cap({ value, period: "day", evidence: `${value} a day` });
    assert.equal(r.code, "range", value);
  }
  const r = cap({ value: "300", period: "day", evidence: "300-400 a day" });
  assert.equal(r.code, "range");
});

test("upper and lower bounds stay qualified", () => {
  assert.equal(
    cap({ value: "up to 400", period: "day", evidence: "up to 400 a day" })
      .code,
    "upper_bound",
  );
  assert.equal(
    cap({ value: "400", period: "day", evidence: "max 400 a day" }).code,
    "upper_bound",
  );
  assert.equal(
    cap({ value: "400", period: "day", evidence: "400 a day max" }).code,
    "upper_bound",
  );
  assert.equal(
    cap({ value: "400", period: "day", evidence: "at least 400 a day" }).code,
    "lower_bound",
  );
  assert.equal(
    cap({ value: "400+", period: "day", evidence: "400+ a day" }).code,
    "lower_bound",
  );
});

test("conditional wording blocks promotion", () => {
  const r = cap({
    value: "150",
    period: "day",
    evidence: "150 a day, subject to confirmation",
  });
  assert.equal(r.code, "conditional");
  assert.equal(
    cap({
      value: "150",
      period: "day",
      evidence: "150 a day",
      qualifier: "conditional",
    }).code,
    "conditional",
  );
});

test("approximate figures are kept but flagged", () => {
  const r = cap({
    value: "about 400",
    period: "day",
    evidence: "about 400 a day",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 400);
  assert.match(r.applied.join(), /approximate/);
  assert.equal(
    cap({ value: "400", period: "day", evidence: "400 a day, give or take" })
      .ok,
    true,
  );
});

test("qualifier words inside other words or dates do not trigger", () => {
  assert.equal(
    cap({ value: "400", period: "day", evidence: "after handover 400 a day" })
      .ok,
    true,
  );
  assert.equal(
    cap({
      value: "400",
      period: "day",
      evidence: "Order 1234 - 400 units a day",
    }).ok,
    true,
  );
  assert.equal(
    cap({ value: "400", period: "day", evidence: "Sent 2026-09-21: 400 a day" })
      .ok,
    true,
  );
});

test("conflicting periods are reviewed, not resolved by priority", () => {
  const fields = cap({
    value: "400",
    unit: "a week",
    period: "day",
    evidence: "400 a week",
  });
  assert.equal(fields.code, "period_conflict");
  const text = cap({
    value: "400",
    evidence: "400 units per day, 2,800 per week",
  });
  assert.equal(text.code, "period_conflict");
  // A reported period that the text supports wins over other periods nearby.
  assert.equal(
    cap({
      value: "400",
      period: "day",
      evidence: "400 units per day, 2,800 per week",
    }).ok,
    true,
  );
});

test("zero capacity is meaningful without a period", () => {
  const r = cap({ value: "0", evidence: "capacity: 0 (machine down)" });
  assert.equal(r.ok, true);
  assert.equal(r.value, 0);
});

test("unreadable and negative values are quarantined, not reviewed", () => {
  assert.equal(
    cap({ value: "4l.8O", period: "day", evidence: "4l.8O a day" }).disposition,
    "quarantine",
  );
  assert.equal(
    cap({ value: "-5", period: "day", evidence: "-5 a day" }).disposition,
    "quarantine",
  );
});

test("stated window that ended, or has not started, does not establish capacity", () => {
  const base = {
    value: "400",
    period: "day",
    evidence: "400 a day",
    observedAt: "2026-09-10T00:00:00Z",
  };
  assert.equal(
    cap({ ...base, effectiveUntil: "2026-09-01" }).code,
    "window_expired",
  );
  assert.equal(
    cap({ ...base, effectiveFrom: "2026-09-20" }).code,
    "window_future",
  );
  assert.equal(
    cap({ ...base, effectiveFrom: "2026-09-05", effectiveUntil: "2026-09-01" })
      .code,
    "window_inverted",
  );
  const ok = cap({
    ...base,
    effectiveFrom: "2026-09-01",
    effectiveUntil: "2026-09-30",
  });
  assert.equal(ok.ok, true);
  assert.match(ok.applied.join(), /effective 2026-09-01 to 2026-09-30/);
  // An unstated window is not disqualifying by itself.
  assert.equal(cap(base).ok, true);
});

test("qualifier detection is local to the number", () => {
  const q = detectQualifiers({
    value: "400",
    evidence: "Prices are tentative. We do 400 a day. Machines: up to 9 heads.",
  });
  assert.deepEqual(q, []);
});

test("period resolution reports how it decided", () => {
  assert.equal(
    resolvePeriod({ unit: "units/day", period: "", evidence: "", value: "1" })
      .source,
    "fields",
  );
  assert.equal(
    resolvePeriod({ unit: "", period: "", evidence: "1 a week", value: "1" })
      .source,
    "text",
  );
  assert.equal(
    resolvePeriod({ unit: "", period: "", evidence: "1", value: "1" }).status,
    "missing",
  );
});

test("a revised figure does not inherit the earlier figure's period", () => {
  const inherited = cap({
    value: "~500",
    period: "day",
    evidence: "actually hold on ~500 snack packs staff out sick",
    ambiguity: "Revised from earlier '143 a day'; latest value approximate",
  });
  assert.equal(inherited.ok, false);
  assert.equal(inherited.code, "period_inherited");
});

test("a revision that states its own period is still a claim", () => {
  const r = cap({
    value: "200",
    period: "day",
    evidence: "actually make that 200 a day",
    ambiguity: "Revised from earlier '400 a day'",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 200);
});

test("the inherited-period guard only applies to figures the extractor calls revisions", () => {
  const r = cap({
    value: "500",
    period: "day",
    evidence: "500 snack packs",
    ambiguity: "",
  });
  assert.equal(r.ok, true);
});
