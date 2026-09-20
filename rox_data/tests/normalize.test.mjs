import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFact, parseNumber } from "../pipeline/normalize.mjs";

const cap = (o) =>
  normalizeFact({ fieldKind: "capacity", unit: "", period: "", ...o });

test("strict is the default: a bare number is not promoted to per-day", () => {
  const r = cap({ value: "400", evidence: "about 400" });
  assert.equal(r.ok, false);
  assert.equal(r.disposition, "needs_review");
  assert.equal(r.code, "no_period");
});

test("legacy policy reproduces the historical per-day assumption, and says so", () => {
  const r = cap({
    value: "400",
    evidence: "about 400",
    capacityPolicy: "legacy",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 400);
  assert.match(r.applied.join(), /assumed per-day/);
  // Legacy also keeps the known-unsafe behaviour of reading "up to N" as N.
  assert.equal(
    cap({
      value: "up to 400",
      evidence: "up to 400 a day",
      capacityPolicy: "legacy",
    }).value,
    400,
  );
  assert.equal(
    cap({ value: "up to 400", evidence: "up to 400 a day" }).code,
    "upper_bound",
  );
});

test("strict routes ranges to review instead of quarantine-as-junk", () => {
  const r = cap({ value: "300-400", period: "day", evidence: "300-400 a day" });
  assert.equal(r.disposition, "needs_review");
  assert.equal(r.code, "range");
});

test("supported conversions are unchanged and still show their work", () => {
  const r = cap({
    value: "2,800",
    unit: "a week",
    period: "week",
    evidence: "2,800 a week",
  });
  assert.equal(r.value, 400);
  assert.equal(r.unit, "units/day");
});

test("non-capacity fields keep their behaviour", () => {
  const lead = normalizeFact({
    fieldKind: "lead_time_hours",
    value: "2",
    unit: "business days",
    evidence: "",
  });
  assert.equal(lead.value, 16);
  const price = normalizeFact({
    fieldKind: "price",
    value: "$8.00",
    unit: "USD",
    evidence: "",
  });
  assert.equal(price.unit, "CAD");
  assert.equal(
    normalizeFact({
      fieldKind: "moq",
      value: "12",
      unit: "units",
      evidence: "",
    }).value,
    12,
  );
  assert.equal(
    normalizeFact({
      fieldKind: "price",
      value: "call for pricing",
      evidence: "",
    }).ok,
    false,
  );
});

test("parseNumber is still exported for the evaluator", () => {
  assert.equal(parseNumber("four hundred"), 400);
  assert.equal(parseNumber("2,800"), 2800);
  assert.equal(parseNumber("4l.8O"), null);
});
