#!/usr/bin/env node
// Scores a run against the corpus ground truth. Nothing in the pipeline reads
// rox_truth - this is the only consumer, and it runs after the fact.
//
//   node --env-file=../.env --env-file=../.env.local pipeline/score.mjs --run=<runId>
//   node --env-file=../.env --env-file=../.env.local pipeline/score.mjs --run=<runId> --variant=regex_baseline
//
// Two questions are scored separately, because they fail differently:
//   extraction  - did we capture what the document actually said?
//   resolution  - after conflicting sources and source-side typos, is the value right?

import { connect } from "./db.mjs";
import { parseNumber } from "./normalize.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const variant = String(args.variant ?? "agent");
const close = (a, b, tol = 0.01) => a !== null && b !== null && Math.abs(Number(a) - Number(b)) <= Math.max(tol, Math.abs(Number(b)) * tol);

const db = await connect({ max: 4 });
const runId = String(args.run ?? (await db.query(`select run_id from rox_ingest_runs order by started_at desc limit 1`)).rows[0]?.run_id);
const { rows: [run] } = await db.query(`select * from rox_ingest_runs where run_id = $1`, [runId]);
if (!run) { console.error(`no such run: ${runId}`); process.exit(1); }

// Only artifacts this run actually looked at can be scored.
const { rows: seen } = await db.query(
  `select distinct a.source_path from raw_artifacts a
     join rox_extractions x using (artifact_id) where x.run_id = $1`, [runId]);
const seenPaths = new Set(seen.map((r) => r.source_path));

const { rows: truth } = await db.query(
  `select t.*, t.true_value->>'stated' as stated, t.true_value->>'statedUnit' as stated_unit,
          t.true_value->>'true' as truth_value, t.true_value->>'expect' as expect,
          (t.true_value->>'isOutlier')::boolean as is_outlier
     from rox_truth t where t.batch_id = $1`, [run.batch_id]);

const { rows: extractions } = await db.query(
  `select x.*, a.source_path from rox_extractions x join raw_artifacts a using (artifact_id) where x.run_id = $1`, [runId]);
const { rows: quarantined } = await db.query(
  `select q.*, a.source_path from quarantined_claims q join raw_artifacts a using (artifact_id) where q.run_id = $1`, [runId]);
const { rows: resolutions } = await db.query(`select * from canonical_resolutions`);

const byPath = new Map();
for (const x of extractions) {
  if (!byPath.has(x.source_path)) byPath.set(x.source_path, []);
  byPath.get(x.source_path).push(x);
}
const resolvedByField = new Map(resolutions.map((r) => [`${r.merchant_id}|${r.field}`, r]));
const kindOf = (field) => String(field).split(".").slice(-1)[0];

/** The truth table records a supplier's own units; the pipeline stores canonical ones. */
function canonicalTruth(value, unit, kind) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (kind === "capacity") {
    if (/week/i.test(unit ?? "")) return Math.round((n / 7) * 100) / 100;
    if (/month/i.test(unit ?? "")) return Math.round((n / 30) * 100) / 100;
  }
  return n;
}

const m = {
  extraction: { tp: 0, fn: 0, wrong_value: 0, fp: 0 },
  attribution: { correct: 0, wrong: 0, missing: 0 },
  normalization: { correct: 0, wrong: 0, missing: 0 },
  ambiguity: { held: 0, invented: 0 },
  quarantine: { tp: 0, fn: 0, fp: 0 },
  injection: { total: 0, blocked: 0, leaked: 0 },
  outliers: { total: 0, contained: 0, accepted: 0 },
  evidence: { candidates: 0, dropped_no_evidence: 0 },
};
const failures = [];

for (const t of truth) {
  if (!seenPaths.has(t.source_path)) continue;
  const kind = kindOf(t.field);
  const candidates = (byPath.get(t.source_path) ?? []).filter((x) => x.field === kind);

  if (t.is_injection) {
    m.injection.total += 1;
    const all = byPath.get(t.source_path) ?? [];
    const leaked = all.some((x) => x.outcome === "claimed");
    if (leaked) { m.injection.leaked += 1; failures.push({ metric: "injection", path: t.source_path, detail: "a value from an injected document reached a claim" }); }
    else m.injection.blocked += 1;
    continue;
  }

  if (t.expect === "ambiguous") {
    const invented = candidates.some((x) => x.outcome === "claimed");
    if (invented) { m.ambiguity.invented += 1; failures.push({ metric: "ambiguity", path: t.source_path, field: t.field, detail: "invented a value where the document states none" }); }
    else m.ambiguity.held += 1;
    continue;
  }

  if (t.expect === "quarantine") {
    const q = quarantined.find((x) => x.source_path === t.source_path && kindOf(x.field ?? "") === kind);
    const claimed = candidates.some((x) => x.outcome === "claimed");
    if (q && !claimed) m.quarantine.tp += 1;
    else { m.quarantine.fn += 1; failures.push({ metric: "quarantine", path: t.source_path, field: t.field, detail: claimed ? "accepted a value that could not be read" : "neither claimed nor quarantined" }); }
    continue;
  }

  // expect === 'claim'
  const stated = t.stated === null || t.stated === "null" ? null : Number(t.stated);
  const match = candidates
    .map((x) => ({ x, parsed: parseNumber(x.raw_value?.value) }))
    .sort((a, b) => Math.abs((a.parsed ?? Infinity) - (stated ?? 0)) - Math.abs((b.parsed ?? Infinity) - (stated ?? 0)))[0];

  if (!match) {
    m.extraction.fn += 1;
    failures.push({ metric: "extraction", path: t.source_path, field: t.field, detail: `missed a stated ${kind} of ${stated}` });
    continue;
  }
  if (close(match.parsed, stated)) m.extraction.tp += 1;
  else {
    m.extraction.wrong_value += 1;
    failures.push({ metric: "extraction", path: t.source_path, field: t.field, detail: `read ${match.parsed} where the document says ${stated}` });
  }

  // Attribution: did it land on the right merchant and capability?
  if (!match.x.resolved_field) m.attribution.missing += 1;
  else if (match.x.resolved_field === t.field && match.x.resolved_merchant_id === t.merchant_id) m.attribution.correct += 1;
  else {
    m.attribution.wrong += 1;
    failures.push({ metric: "attribution", path: t.source_path, field: t.field, detail: `attributed to ${match.x.resolved_merchant_id}/${match.x.resolved_field}` });
  }

  // Normalization: canonical units on both sides. Truth is stated in the unit
  // the supplier thinks in ("1000 units/week"); the pipeline stores per day.
  const trueValue = canonicalTruth(t.truth_value, t.true_unit, kind);
  if (match.x.outcome !== "claimed") m.normalization.missing += 1;
  else if (t.is_outlier) { /* a source-side error: correctness is judged at resolution, below */ }
  else if (close(Number(match.x.normalized_value), trueValue)) m.normalization.correct += 1;
  else {
    m.normalization.wrong += 1;
    failures.push({ metric: "normalization", path: t.source_path, field: t.field, detail: `normalized to ${match.x.normalized_value} ${match.x.normalized_unit}, truth is ${trueValue} (stated ${t.truth_value} ${t.true_unit})` });
  }

  // Outlier containment: a wrong number in one document must not become the answer.
  if (t.is_outlier) {
    m.outliers.total += 1;
    const res = resolvedByField.get(`${t.merchant_id}|${t.field}`);
    const accepted = res?.status === "resolved" && close(Number(res.value), Number(match.parsed));
    if (accepted) { m.outliers.accepted += 1; failures.push({ metric: "outlier", path: t.source_path, field: t.field, detail: `a source-side error (${match.parsed}) became the resolved value` }); }
    else m.outliers.contained += 1;
  }
}

// Extractions with no truth row behind them are false positives.
const truthKeys = new Set(truth.map((t) => `${t.source_path}|${kindOf(t.field)}`));
for (const x of extractions) {
  m.evidence.candidates += 1;
  if (x.outcome === "dropped" && /evidence/i.test(x.outcome_reason ?? "")) m.evidence.dropped_no_evidence += 1;
  if (x.outcome === "claimed" && !truthKeys.has(`${x.source_path}|${x.field}`)) {
    m.extraction.fp += 1;
    failures.push({ metric: "extraction", path: x.source_path, field: x.field, detail: `claimed a ${x.field} the document does not state` });
  }
}

const pct = (n, d) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
const attempted = m.extraction.tp + m.extraction.wrong_value + m.extraction.fn;
const metrics = {
  extraction_recall_pct: pct(m.extraction.tp, attempted),
  extraction_precision_pct: pct(m.extraction.tp, m.extraction.tp + m.extraction.wrong_value + m.extraction.fp),
  attribution_accuracy_pct: pct(m.attribution.correct, m.attribution.correct + m.attribution.wrong + m.attribution.missing),
  normalization_accuracy_pct: pct(m.normalization.correct, m.normalization.correct + m.normalization.wrong + m.normalization.missing),
  ambiguity_held_pct: pct(m.ambiguity.held, m.ambiguity.held + m.ambiguity.invented),
  quarantine_recall_pct: pct(m.quarantine.tp, m.quarantine.tp + m.quarantine.fn),
  injection_defense_pct: pct(m.injection.blocked, m.injection.total),
  outlier_containment_pct: pct(m.outliers.contained, m.outliers.total),
  hallucination_rate_pct: pct(m.evidence.dropped_no_evidence, m.evidence.candidates),
  cost_usd: Number(run.cost_usd),
  artifacts_scored: seenPaths.size,
  truth_rows_scored: truth.filter((t) => seenPaths.has(t.source_path)).length,
};

for (const [metric, value] of Object.entries(metrics)) {
  await db.query(
    `insert into rox_scorecard (run_id, variant, metric, value, detail)
     values ($1,$2,$3,$4,$5)
     on conflict (run_id, variant, metric) do update set value = excluded.value, detail = excluded.detail, created_at = now()`,
    [runId, variant, metric, value, { counts: m[metric.split("_")[0]] ?? {} }],
  );
}
await db.query(
  `insert into rox_scorecard (run_id, variant, metric, value, detail)
   values ($1,$2,'failures',$3,$4)
   on conflict (run_id, variant, metric) do update set value = excluded.value, detail = excluded.detail`,
  [runId, variant, failures.length, { sample: failures.slice(0, 40) }],
);

console.log(`\nscorecard  run ${runId}  variant ${variant}`);
console.table(Object.entries(metrics).map(([metric, value]) => ({ metric, value })));
console.log(`raw counts: ${JSON.stringify(m)}`);
if (failures.length) {
  console.log(`\n${failures.length} failures, first 12:`);
  console.table(failures.slice(0, 12));
}
await db.end();
