import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeFact } from "./normalize.mjs";

for (const fieldKind of ["capacity", "lead_time_hours", "price"]) {
  test(`${fieldKind} quarantines absent units instead of inventing operational facts`, () => {
    for (const value of [0, 100]) {
      const result = normalizeFact({ fieldKind, value });
      assert.equal(result.ok, false);
      assert.match(result.reason, /missing/);
    }
  });
}

test("unsupported explicit units are not rescued by unrelated evidence", () => {
  for (const input of [
    { fieldKind: "capacity", unit: "units/hour", evidence: "Sent this week" },
    { fieldKind: "capacity", period: "year", unit: "units/day" },
    {
      fieldKind: "lead_time_hours",
      unit: "weeks",
      evidence: "Our office hours",
    },
    { fieldKind: "price", unit: "JPY", evidence: "Compare with the CAD offer" },
    { fieldKind: "price", unit: "$" },
  ]) {
    const result = normalizeFact({ value: 100, ...input });
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match(result.reason, /unsupported/);
  }
});

test("supported capacity periods preserve per-day conversion and evidence", () => {
  for (const [input, expected, period] of [
    [{ unit: "units/day" }, 210, "day"],
    [{ period: "week" }, 30, "week"],
    [{ unit: "units/month" }, 7, "month"],
    [{ evidence: "We can produce 210 units per week." }, 30, "week"],
    [{ value: "210 units/week" }, 30, "week"],
  ]) {
    const result = normalizeFact({
      fieldKind: "capacity",
      value: 210,
      ...input,
    });
    assert.equal(result.ok, true, JSON.stringify(input));
    assert.equal(result.value, expected);
    assert.equal(result.unit, "units/day");
    assert.equal(result.statedPeriod, period);
    assert.equal(
      result.applied.some((step) => step.includes("assumed")),
      false,
    );
  }
});

test("supported lead-time units preserve duration conversions", () => {
  for (const [input, expected] of [
    [{ unit: "hours" }, 2],
    [{ unit: "days" }, 48],
    [{ unit: "business days" }, 16],
    [{ evidence: "Lead time is 2 working days." }, 16],
    [{ value: "2 hours" }, 2],
  ]) {
    const result = normalizeFact({
      fieldKind: "lead_time_hours",
      value: 2,
      ...input,
    });
    assert.equal(result.ok, true, JSON.stringify(input));
    assert.equal(result.value, expected);
    assert.equal(result.unit, "hours");
  }
});

test("explicit supported currencies retain the existing frozen conversion policy", () => {
  for (const [input, expected] of [
    [{ value: 100, unit: "CAD" }, 100],
    [{ value: 74, unit: "USD" }, 100],
    [{ value: 58, unit: "GBP" }, 100],
    [{ value: 68, unit: "EUR" }, 100],
    [{ value: 58, unit: "£" }, 100],
    [{ value: 68, evidence: "Price is 68 EUR per unit." }, 100],
    [{ value: "CAD 100" }, 100],
    [{ value: 74, evidence: "Price is USD 74" }, 100],
  ]) {
    const result = normalizeFact({ fieldKind: "price", ...input });
    assert.equal(result.ok, true, JSON.stringify(input));
    assert.equal(result.value, expected);
    assert.equal(result.unit, "CAD");
  }
});

test("conflicting unit evidence stays ambiguous", () => {
  for (const input of [
    { fieldKind: "capacity", evidence: "100 per day or week" },
    { fieldKind: "capacity", period: "week", unit: "units/day" },
    { fieldKind: "lead_time_hours", unit: "days or hours" },
    { fieldKind: "lead_time_hours", unit: "days or weeks" },
    { fieldKind: "lead_time_hours", unit: "hours or months" },
    { fieldKind: "price", unit: "USD or CAD" },
    { fieldKind: "price", unit: "CAD or JPY" },
    { fieldKind: "price", evidence: "USD 100 CAD" },
    { fieldKind: "price", evidence: "JPY 100 CAD" },
    { fieldKind: "price", evidence: "USD 100 JPY" },
    { fieldKind: "capacity", evidence: "per week 100 units/day" },
    { fieldKind: "capacity", evidence: "per year 100 units/day" },
    { fieldKind: "lead_time_hours", value: 2, evidence: "hours 2 days" },
    { fieldKind: "lead_time_hours", value: 2, evidence: "weeks 2 days" },
  ]) {
    assert.equal(normalizeFact({ value: 100, ...input }).ok, false);
  }
});

test("unrelated multi-fact evidence cannot establish a missing unit", () => {
  for (const input of [
    { fieldKind: "capacity", evidence: "100 units. We work 7 days per week." },
    {
      fieldKind: "lead_time_hours",
      evidence: "Lead time 100; office open 8 hours.",
    },
    { fieldKind: "price", evidence: "Price 100 JPY, shipping 10 CAD." },
  ]) {
    assert.equal(normalizeFact({ value: 100, ...input }).ok, false);
  }
});
