import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadScoreInputs,
  scoreRun,
  persistScorecard,
  SCORER_VERSION,
} from "./score.mjs";

const run = { run_id: "run-one", batch_id: "batch-one", cost_usd: 0 };
const row = (extra) => ({
  ...run,
  artifact_id: "artifact-one",
  source_path: "supplier/one.txt",
  ...extra,
});
const expected = (extra) => ({
  batch_id: run.batch_id,
  source_path: "supplier/one.txt",
  field: "cap.capacity",
  merchant_id: "supplier",
  stated: "700",
  truth_value: "700",
  true_unit: "units/week",
  expect: "claim",
  ...extra,
});
const extracted = (extra) =>
  row({
    field: "capacity",
    raw_value: { value: "700" },
    outcome: "claimed",
    resolved_field: "cap.capacity",
    resolved_merchant_id: "supplier",
    normalized_value: 100,
    normalized_unit: "units/day",
    claim_id: "claim-one",
    ...extra,
  });
const input = (extra) => ({
  run,
  population: [row({ recorded_attempt: true })],
  truth: [expected()],
  extractions: [],
  quarantined: [],
  resolutions: [],
  ...extra,
});

test("zero-extraction attempted documents count as missed expected claims", () => {
  const result = scoreRun(input());
  assert.equal(result.metrics.artifacts_scored, 1);
  assert.equal(result.metrics.artifacts_zero_extractions, 1);
  assert.equal(result.metrics.extraction_recall_pct, 0);
  assert.equal(result.metrics.attribution_accuracy_pct, 0);
  assert.equal(result.metrics.normalization_accuracy_pct, 0);
  assert.equal(result.counts.extraction.fn, 1);
});
test("normalizes weekly truth and requires both correct numeric value and units", () => {
  assert.equal(
    scoreRun(input({ extractions: [extracted()] })).metrics
      .normalization_accuracy_pct,
    100,
  );
  for (const changed of [
    { normalized_unit: "units/week" },
    { normalized_value: null },
    { normalized_unit: null },
  ])
    assert.equal(
      scoreRun(input({ extractions: [extracted(changed)] })).metrics
        .normalization_accuracy_pct,
      0,
    );
});
test("does not convert a missing normalized value into a correct zero", () => {
  const result = scoreRun(
    input({
      truth: [expected({ stated: "0", truth_value: "0" })],
      extractions: [
        extracted({ raw_value: { value: 0 }, normalized_value: null }),
      ],
    }),
  );
  assert.equal(result.metrics.extraction_recall_pct, 100);
  assert.equal(result.metrics.normalization_accuracy_pct, 0);
});
test("ignores other-run and other-batch rows even if artifact paths overlap", () => {
  const foreign = extracted({ run_id: "other-run" });
  const result = scoreRun(
    input({
      population: [
        row({ recorded_attempt: true }),
        row({ artifact_id: "foreign", run_id: "other-run" }),
      ],
      extractions: [foreign, extracted({ batch_id: "other-batch" })],
      truth: [expected(), expected({ batch_id: "other-batch" })],
    }),
  );
  assert.equal(result.metrics.artifacts_scored, 1);
  assert.equal(result.metrics.truth_rows_scored, 1);
  assert.equal(result.metrics.extraction_recall_pct, 0);
});
test("quarantine-only artifacts are included without manufacturing extraction output", () => {
  const result = scoreRun(
    input({
      population: [row({ recorded_attempt: false })],
      truth: [expected({ expect: "quarantine" })],
      quarantined: [row({ field: "cap.capacity" })],
    }),
  );
  assert.equal(result.metrics.quarantine_recall_pct, 100);
  assert.equal(result.metrics.artifacts_without_attempt_record, 1);
  assert.equal(result.metrics.artifacts_zero_extractions, 1);
});
test("irrelevant zero-result documents do not manufacture false negatives", () => {
  const result = scoreRun(input({ truth: [expected({ expect: "ignore" })] }));
  assert.equal(result.metrics.artifacts_scored, 1);
  assert.equal(result.counts.extraction.fn, 0);
});
test("one extraction cannot satisfy two expected facts or hide duplicate claims", () => {
  const missing = scoreRun(
    input({
      truth: [expected(), expected({ field: "second.capacity" })],
      extractions: [extracted()],
    }),
  );
  assert.equal(missing.counts.extraction.tp, 1);
  assert.equal(missing.counts.extraction.fn, 1);
  const duplicate = scoreRun(
    input({ extractions: [extracted(), extracted({ claim_id: "extra" })] }),
  );
  assert.equal(duplicate.counts.extraction.tp, 1);
  assert.equal(duplicate.counts.extraction.fp, 1);
});
test("missing or unrelated run resolution cannot receive outlier-containment credit", () => {
  const result = scoreRun(
    input({
      truth: [expected({ is_outlier: true })],
      extractions: [extracted()],
      resolutions: [
        {
          run_id: "another-run",
          merchant_id: "supplier",
          field: "cap.capacity",
          status: "conflicted",
        },
      ],
    }),
  );
  assert.equal(result.counts.outliers.unobserved, 1);
  assert.equal(result.metrics.outlier_containment_pct, null);
  assert.equal(result.metrics.outlier_resolution_coverage_pct, 0);
});
test("outlier acceptance compares canonical values and same-run claim identity", () => {
  const result = scoreRun(
    input({
      truth: [expected({ is_outlier: true })],
      extractions: [extracted()],
      resolutions: [
        {
          run_id: run.run_id,
          merchant_id: "supplier",
          field: "cap.capacity",
          status: "resolved",
          value: 100,
          claim_id: "claim-one",
        },
      ],
    }),
  );
  assert.equal(result.counts.outliers.accepted, 1);
  assert.equal(result.metrics.outlier_containment_pct, 0);
  assert.equal(result.metrics.outlier_resolution_coverage_pct, 100);
});
test("injection-bearing documents are evaluated even when their ordinary truth is ignore", () => {
  const result = scoreRun(
    input({
      truth: [expected({ expect: "ignore", is_injection: true })],
      extractions: [extracted()],
    }),
  );
  assert.equal(result.counts.injection.leaked, 1);
});
test("loader uses scoped attempt population and persisted run events, not current global resolution", async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: sql.startsWith("select * from rox_ingest_runs") ? [run] : [],
      };
    },
  };
  await loadScoreInputs(db, run.run_id);
  assert.ok(
    calls.some(
      ({ sql, params }) =>
        sql.includes("rox_artifact_attempts") &&
        params[0] === run.run_id &&
        params[1] === run.batch_id,
    ),
  );
  assert.ok(
    calls.some(
      ({ sql, params }) =>
        sql.includes("rox.run.started") && params[0] === run.run_id,
    ),
  );
  assert.ok(calls.every(({ sql }) => !sql.includes("canonical_resolutions")));
});
test("persisted metrics include scorer and evidence-source versions", async () => {
  const calls = [];
  await persistScorecard(
    { query: async (sql, params) => calls.push({ sql, params }) },
    run.run_id,
    "test",
    scoreRun(input()),
  );
  assert.ok(calls.length > 10);
  assert.ok(
    calls.every(
      ({ params }) =>
        params[0] === run.run_id &&
        params.at(-1).scorerVersion === SCORER_VERSION,
    ),
  );
});
