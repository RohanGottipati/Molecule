import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, canonicalExpected } from "../pipeline/evaluate.mjs";
function fixture() {
  return {
    artifacts: [
      {
        artifact_id: "a",
        source_path: "emails/a",
        content_text: "Capacity 200 units/day",
      },
    ],
    truth: [
      {
        truth_id: "t",
        source_path: "emails/a",
        merchant_id: "m",
        field: "cap.capacity",
        true_value: {
          expect: "claim",
          stated: 200,
          statedUnit: "units/day",
          true: 999,
        },
      },
    ],
    extractions: [
      {
        extraction_id: "x",
        source_path: "emails/a",
        field: "capacity",
        raw_value: { value: 200 },
        resolved_merchant_id: "m",
        resolved_field: "cap.capacity",
        outcome: "claimed",
        normalized_value: 200,
        normalized_unit: "units/day",
        evidence_text: "200 units/day",
      },
    ],
    quarantined: [],
    attempts: [{ artifact_id: "a" }],
    config: { businessDayHours: 8, fxToCad: { CAD: 1, USD: 1.25 } },
  };
}
test("correct stated value wins despite stale underlying truth", () =>
  assert.equal(evaluate(fixture()).metrics.normalization_accuracy_pct, 100));
test("empty completed document counts as missed extraction", () => {
  const s = fixture();
  s.extractions = [];
  assert.equal(evaluate(s).metrics.extraction_recall_pct, 0);
  assert.equal(evaluate(s).metrics.attribution_accuracy_pct, 0);
});
test("selected but failed document remains in denominator", () => {
  const s = fixture();
  s.attempts = [];
  s.extractions = [];
  const r = evaluate(s);
  assert.equal(r.metrics.extraction_recall_pct, 0);
  assert.equal(r.counts.population.completed, 0);
});
test("one extraction cannot satisfy two facts", () => {
  const s = fixture();
  s.truth.push({ ...s.truth[0], truth_id: "t2" });
  assert.equal(evaluate(s).metrics.extraction_recall_pct, 50);
});
test("duplicate predictions reduce precision", () => {
  const s = fixture();
  s.extractions.push({ ...s.extractions[0], extraction_id: "x2" });
  assert.equal(evaluate(s).metrics.extraction_precision_pct, 50);
});
test("value present but wrong supplier fails attribution", () => {
  const s = fixture();
  s.extractions[0].resolved_merchant_id = "wrong";
  assert.equal(evaluate(s).metrics.attribution_accuracy_pct, 0);
});
test("normalization requires correct units and rejects null as zero", () => {
  const s = fixture();
  s.extractions[0].normalized_unit = "units/week";
  assert.equal(evaluate(s).metrics.normalization_accuracy_pct, 0);
  s.truth[0].true_value.stated = 0;
  s.extractions[0].normalized_unit = "units/day";
  s.extractions[0].normalized_value = null;
  assert.equal(evaluate(s).metrics.normalization_accuracy_pct, 0);
});
test("frozen currency, calendar and business day conversions", () => {
  const c = fixture().config;
  assert.deepEqual(
    canonicalExpected(2, "business_days", "lead_time_hours", c),
    { value: 16, unit: "hours" },
  );
  assert.equal(canonicalExpected(2, "days", "lead_time_hours", c).value, 48);
  assert.equal(canonicalExpected(8, "USD", "price", c).value, 10);
  assert.equal(canonicalExpected(700, "units/week", "capacity", c).value, 100);
  assert.equal(canonicalExpected(2, "unknown", "price", c), null);
});
test("failed injection is not a successful defense", () => {
  const s = fixture();
  s.truth[0].is_injection = true;
  s.extractions = [];
  s.attempts = [];
  assert.equal(evaluate(s).metrics.injection_defense_pct, 0);
  s.attempts = [{ artifact_id: "a" }];
  assert.equal(evaluate(s).metrics.injection_defense_pct, 100);
});
test("ambiguous input must finish before it counts as held", () => {
  const s = fixture();
  s.truth[0].true_value.expect = "ambiguous";
  s.extractions = [];
  s.attempts = [];
  assert.equal(evaluate(s).metrics.ambiguity_held_pct, 0);
});
test("quarantine needs a record and no promoted claim", () => {
  const s = fixture();
  s.truth[0].true_value.expect = "quarantine";
  s.quarantined = [{ source_path: "emails/a", field: "capacity" }];
  assert.equal(evaluate(s).metrics.quarantine_recall_pct, 0);
  s.extractions = [];
  assert.equal(evaluate(s).metrics.quarantine_recall_pct, 100);
});
test("claimed evidence is checked against source; no resolution invented", () => {
  const s = fixture();
  s.extractions[0].evidence_text = "not in document";
  const r = evaluate(s);
  assert.equal(r.metrics.claimed_evidence_missing_pct, 100);
  assert.equal(r.metrics.outlier_containment_pct, null);
});
test("outlier containment reads only the frozen run resolution snapshot", () => {
  const s = fixture();
  s.truth[0].true_value.isOutlier = true;
  s.resolutions = [
    {
      merchant_id: "m",
      field: "cap.capacity",
      status: "resolved",
      value: 999,
    },
  ];
  assert.equal(evaluate(s).metrics.outlier_containment_pct, 100);
  s.resolutions[0].value = 200;
  const accepted = evaluate(s);
  assert.equal(accepted.metrics.outlier_containment_pct, 0);
  assert.equal(accepted.counts.outliers.accepted, 1);
});
test("reject foreign population and ambiguous source paths", () => {
  const s = fixture();
  s.extractions[0].source_path = "elsewhere";
  assert.throws(() => evaluate(s), /outside/);
  s.extractions = [];
  s.artifacts.push({ ...s.artifacts[0], artifact_id: "b" });
  assert.throws(() => evaluate(s), /Ambiguous/);
});
test("exact matches reserved before wrong predictions", () => {
  const s = fixture();
  s.truth.push({
    ...s.truth[0],
    truth_id: "t2",
    true_value: { ...s.truth[0].true_value, stated: 300 },
  });
  s.extractions[0].raw_value.value = 300;
  const r = evaluate(s);
  assert.equal(r.counts.extraction.correct, 1);
  assert.equal(r.counts.extraction.missing, 1);
});
