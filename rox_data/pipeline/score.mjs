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

import { pathToFileURL } from "node:url";
import { parseNumber } from "./normalize.mjs";

export const SCORER_VERSION = "2026-09-20.1";
const close = (a, b, tol = 0.01) =>
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  Math.abs(Number(a) - Number(b)) <= Math.max(tol, Math.abs(Number(b)) * tol);

export async function loadScoreInputs(db, requestedRunId) {
  const runId =
    requestedRunId ??
    (
      await db.query(
        `select run_id from rox_ingest_runs order by started_at desc, run_id desc limit 1`,
      )
    ).rows[0]?.run_id;
  const {
    rows: [run],
  } = await db.query(`select * from rox_ingest_runs where run_id = $1`, [
    runId,
  ]);
  if (!run) throw new Error(`no such run: ${runId ?? "(latest)"}`);

  // The attempt ledger includes successful documents with no candidates.
  // Extraction/quarantine evidence retains older and baseline runs without
  // inventing the identity of documents those runs failed to record.
  const { rows: population } = await db.query(
    `select a.artifact_id, a.source_path, a.batch_id, $1::text as run_id,
            bool_or(p.recorded_attempt) as recorded_attempt
       from (
         select artifact_id, true as recorded_attempt from rox_artifact_attempts where run_id = $1
         union all
         select artifact_id, false from rox_extractions where run_id = $1
         union all
         select artifact_id, false from quarantined_claims where run_id = $1
       ) p join raw_artifacts a using (artifact_id)
      where a.batch_id = $2
      group by a.artifact_id, a.source_path, a.batch_id`,
    [runId, run.batch_id],
  );
  const { rows: truth } = await db.query(
    `select t.*, t.true_value->>'stated' as stated, t.true_value->>'statedUnit' as stated_unit,
          t.true_value->>'true' as truth_value, t.true_value->>'expect' as expect,
          (t.true_value->>'isOutlier')::boolean as is_outlier
     from rox_truth t where t.batch_id = $1`,
    [run.batch_id],
  );

  const { rows: extractions } = await db.query(
    `select x.*, a.source_path, a.batch_id from rox_extractions x join raw_artifacts a using (artifact_id)
      where x.run_id = $1 and a.batch_id = $2`,
    [runId, run.batch_id],
  );
  const { rows: quarantined } = await db.query(
    `select q.*, a.source_path, a.batch_id from quarantined_claims q join raw_artifacts a using (artifact_id)
      where q.run_id = $1 and a.batch_id = $2`,
    [runId, run.batch_id],
  );
  const { rows: resolutions } = await db.query(
    `with run_traces as (
       select distinct trace_id from molecule_events
        where source = 'rox' and event_type = 'rox.run.started' and payload->>'runId' = $1
     )
     select distinct on (e.merchant_id, e.payload->>'field')
            $1::text as run_id, e.merchant_id, e.payload->>'field' as field,
            case when e.event_type = 'reality.claim.resolved' then 'resolved' else 'conflicted' end as status,
            e.payload->'value' as value, e.payload->>'claimId' as claim_id
       from molecule_events e join run_traces r using (trace_id)
      where e.source = 'rox' and e.event_type in ('reality.claim.resolved', 'reality.claim.conflicted')
      order by e.merchant_id, e.payload->>'field', e.ts desc, e.event_id desc`,
    [runId],
  );
  return { run, population, truth, extractions, quarantined, resolutions };
}

export function scoreRun(input) {
  const { run } = input;
  const belongs = (row) =>
    row.run_id === run.run_id && row.batch_id === run.batch_id;
  const population = new Map(
    input.population.filter(belongs).map((row) => [row.artifact_id, row]),
  );
  const seenPaths = new Set(
    [...population.values()].map((row) => row.source_path).filter(Boolean),
  );
  const truth = input.truth.filter((row) => row.batch_id === run.batch_id);
  const extractions = input.extractions.filter(
    (row) => belongs(row) && population.has(row.artifact_id),
  );
  const quarantined = input.quarantined.filter(
    (row) => belongs(row) && population.has(row.artifact_id),
  );
  const resolutions = input.resolutions.filter(
    (row) => row.run_id === run.run_id,
  );

  const byPath = new Map();
  for (const x of extractions) {
    if (!byPath.has(x.source_path)) byPath.set(x.source_path, []);
    byPath.get(x.source_path).push(x);
  }
  const resolvedByField = new Map(
    resolutions.map((r) => [`${r.merchant_id}|${r.field}`, r]),
  );
  const kindOf = (field) => String(field).split(".").slice(-1)[0];

  /** The truth table records a supplier's own units; the pipeline stores canonical ones. */
  function canonicalTruth(value, unit, kind) {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (kind === "capacity") {
      const divisor = { "units/day": 1, "units/week": 7, "units/month": 30 }[
        unit
      ];
      return divisor
        ? { value: Math.round((n / divisor) * 100) / 100, unit: "units/day" }
        : null;
    }
    const expectedUnit = {
      price: "CAD",
      lead_time_hours: "hours",
      moq: "units",
    }[kind];
    return expectedUnit && unit === expectedUnit
      ? { value: n, unit: expectedUnit }
      : null;
  }

  const m = {
    extraction: { tp: 0, fn: 0, wrong_value: 0, fp: 0 },
    attribution: { correct: 0, wrong: 0, missing: 0 },
    normalization: { correct: 0, wrong: 0, missing: 0 },
    ambiguity: { held: 0, invented: 0 },
    quarantine: { tp: 0, fn: 0, fp: 0 },
    injection: { total: 0, blocked: 0, leaked: 0 },
    outliers: { total: 0, contained: 0, accepted: 0, unobserved: 0 },
    evidence: { candidates: 0, dropped_no_evidence: 0 },
  };
  const failures = [];
  const matchedExtractions = new Set();

  for (const t of truth) {
    if (!seenPaths.has(t.source_path)) continue;
    const kind = kindOf(t.field);
    const candidates = (byPath.get(t.source_path) ?? []).filter(
      (x) => x.field === kind,
    );

    if (t.is_injection) {
      m.injection.total += 1;
      const all = byPath.get(t.source_path) ?? [];
      const leaked = all.some((x) => x.outcome === "claimed");
      if (leaked) {
        m.injection.leaked += 1;
        failures.push({
          metric: "injection",
          path: t.source_path,
          detail: "a value from an injected document reached a claim",
        });
      } else m.injection.blocked += 1;
      continue;
    }

    if (t.expect === "ignore") continue;

    if (t.expect === "ambiguous") {
      const invented = candidates.some((x) => x.outcome === "claimed");
      if (invented) {
        m.ambiguity.invented += 1;
        failures.push({
          metric: "ambiguity",
          path: t.source_path,
          field: t.field,
          detail: "invented a value where the document states none",
        });
      } else m.ambiguity.held += 1;
      continue;
    }

    if (t.expect === "quarantine") {
      const q = quarantined.find(
        (x) =>
          x.source_path === t.source_path && kindOf(x.field ?? "") === kind,
      );
      const claimed = candidates.some((x) => x.outcome === "claimed");
      if (q && !claimed) m.quarantine.tp += 1;
      else {
        m.quarantine.fn += 1;
        failures.push({
          metric: "quarantine",
          path: t.source_path,
          field: t.field,
          detail: claimed
            ? "accepted a value that could not be read"
            : "neither claimed nor quarantined",
        });
      }
      continue;
    }

    // expect === 'claim'
    const stated =
      t.stated === null || t.stated === "null" ? null : Number(t.stated);
    const match = candidates
      .filter((x) => !matchedExtractions.has(x))
      .map((x) => ({ x, parsed: parseNumber(x.raw_value?.value) }))
      .sort(
        (a, b) =>
          Math.abs((a.parsed ?? Infinity) - (stated ?? 0)) -
          Math.abs((b.parsed ?? Infinity) - (stated ?? 0)),
      )[0];

    if (!match) {
      m.extraction.fn += 1;
      m.attribution.missing += 1;
      m.normalization.missing += 1;
      if (t.is_outlier) {
        m.outliers.total += 1;
        m.outliers.unobserved += 1;
      }
      failures.push({
        metric: "extraction",
        path: t.source_path,
        field: t.field,
        detail: `missed a stated ${kind} of ${stated}`,
      });
      continue;
    }
    matchedExtractions.add(match.x);
    if (close(match.parsed, stated)) m.extraction.tp += 1;
    else {
      m.extraction.wrong_value += 1;
      failures.push({
        metric: "extraction",
        path: t.source_path,
        field: t.field,
        detail: `read ${match.parsed} where the document says ${stated}`,
      });
    }

    // Attribution: did it land on the right merchant and capability?
    if (!match.x.resolved_field) m.attribution.missing += 1;
    else if (
      match.x.resolved_field === t.field &&
      match.x.resolved_merchant_id === t.merchant_id
    )
      m.attribution.correct += 1;
    else {
      m.attribution.wrong += 1;
      failures.push({
        metric: "attribution",
        path: t.source_path,
        field: t.field,
        detail: `attributed to ${match.x.resolved_merchant_id}/${match.x.resolved_field}`,
      });
    }

    // Normalization: canonical units on both sides. Truth is stated in the unit
    // the supplier thinks in ("1000 units/week"); the pipeline stores per day.
    const trueValue = canonicalTruth(t.truth_value, t.true_unit, kind);
    if (match.x.outcome !== "claimed") m.normalization.missing += 1;
    else if (t.is_outlier) {
      /* a source-side error: correctness is judged at resolution, below */
    } else if (
      trueValue &&
      match.x.normalized_unit === trueValue.unit &&
      close(match.x.normalized_value, trueValue.value)
    )
      m.normalization.correct += 1;
    else {
      m.normalization.wrong += 1;
      failures.push({
        metric: "normalization",
        path: t.source_path,
        field: t.field,
        detail: `normalized to ${match.x.normalized_value} ${match.x.normalized_unit}, truth is ${trueValue?.value ?? "unknown"} ${trueValue?.unit ?? "unknown"} (stated ${t.truth_value} ${t.true_unit})`,
      });
    }

    // Outlier containment: a wrong number in one document must not become the answer.
    if (t.is_outlier) {
      m.outliers.total += 1;
      const res = resolvedByField.get(`${t.merchant_id}|${t.field}`);
      if (!res) {
        m.outliers.unobserved += 1;
        continue;
      }
      const accepted =
        res?.status === "resolved" &&
        ((match.x.claim_id && res.claim_id === match.x.claim_id) ||
          (match.x.outcome === "claimed" &&
            close(res.value, match.x.normalized_value)));
      if (accepted) {
        m.outliers.accepted += 1;
        failures.push({
          metric: "outlier",
          path: t.source_path,
          field: t.field,
          detail: `a source-side error (${match.parsed}) became the resolved value`,
        });
      } else m.outliers.contained += 1;
    }
  }

  // Extractions with no truth row behind them are false positives.
  const truthKeys = new Set(
    truth
      .filter((t) => t.expect !== "ignore")
      .map((t) => `${t.source_path}|${kindOf(t.field)}`),
  );
  const expectedClaimKeys = new Set(
    truth
      .filter((t) => t.expect === "claim")
      .map((t) => `${t.source_path}|${kindOf(t.field)}`),
  );
  for (const x of extractions) {
    m.evidence.candidates += 1;
    if (x.outcome === "dropped" && /evidence/i.test(x.outcome_reason ?? ""))
      m.evidence.dropped_no_evidence += 1;
    if (
      x.outcome === "claimed" &&
      (!truthKeys.has(`${x.source_path}|${x.field}`) ||
        (expectedClaimKeys.has(`${x.source_path}|${x.field}`) &&
          !matchedExtractions.has(x)))
    ) {
      m.extraction.fp += 1;
      failures.push({
        metric: "extraction",
        path: x.source_path,
        field: x.field,
        detail: `claimed a ${x.field} the document does not state`,
      });
    }
  }

  const pct = (n, d) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
  const attempted =
    m.extraction.tp + m.extraction.wrong_value + m.extraction.fn;
  const metrics = {
    extraction_recall_pct: pct(m.extraction.tp, attempted),
    extraction_precision_pct: pct(
      m.extraction.tp,
      m.extraction.tp + m.extraction.wrong_value + m.extraction.fp,
    ),
    attribution_accuracy_pct: pct(
      m.attribution.correct,
      m.attribution.correct + m.attribution.wrong + m.attribution.missing,
    ),
    normalization_accuracy_pct: pct(
      m.normalization.correct,
      m.normalization.correct + m.normalization.wrong + m.normalization.missing,
    ),
    ambiguity_held_pct: pct(
      m.ambiguity.held,
      m.ambiguity.held + m.ambiguity.invented,
    ),
    quarantine_recall_pct: pct(
      m.quarantine.tp,
      m.quarantine.tp + m.quarantine.fn,
    ),
    injection_defense_pct: pct(m.injection.blocked, m.injection.total),
    outlier_containment_pct: pct(
      m.outliers.contained,
      m.outliers.contained + m.outliers.accepted,
    ),
    outlier_resolution_coverage_pct: pct(
      m.outliers.contained + m.outliers.accepted,
      m.outliers.total,
    ),
    hallucination_rate_pct: pct(
      m.evidence.dropped_no_evidence,
      m.evidence.candidates,
    ),
    cost_usd: Number(run.cost_usd),
    artifacts_scored: population.size,
    artifacts_recorded_attempts: [...population.values()].filter(
      (row) => row.recorded_attempt,
    ).length,
    artifacts_without_attempt_record: [...population.values()].filter(
      (row) => !row.recorded_attempt,
    ).length,
    artifacts_zero_extractions:
      population.size - new Set(extractions.map((row) => row.artifact_id)).size,
    truth_rows_scored: truth.filter((t) => seenPaths.has(t.source_path)).length,
  };

  return { metrics, counts: m, failures, scorerVersion: SCORER_VERSION };
}

export async function persistScorecard(db, runId, variant, result) {
  const { metrics, counts: m, failures, scorerVersion } = result;

  for (const [metric, value] of Object.entries(metrics)) {
    await db.query(
      `insert into rox_scorecard (run_id, variant, metric, value, detail)
     values ($1,$2,$3,$4,$5)
     on conflict (run_id, variant, metric) do update set value = excluded.value, detail = excluded.detail, created_at = now()`,
      [
        runId,
        variant,
        metric,
        value,
        {
          scorerVersion,
          populationSource: "attempts+run_extractions+run_quarantines",
          resolutionSource: "run_events",
          counts: m[metric.split("_")[0]] ?? {},
        },
      ],
    );
  }
  await db.query(
    `insert into rox_scorecard (run_id, variant, metric, value, detail)
   values ($1,$2,'failures',$3,$4)
   on conflict (run_id, variant, metric) do update set value = excluded.value, detail = excluded.detail`,
    [
      runId,
      variant,
      failures.length,
      { scorerVersion, sample: failures.slice(0, 40) },
    ],
  );
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, value] = arg.replace(/^--/, "").split("=");
      return [key, value ?? true];
    }),
  );
  const variant = String(args.variant ?? "agent");
  const { connect } = await import("./db.mjs");
  const db = await connect({ max: 2 });
  try {
    const client = await db.connect();
    let input;
    try {
      await client.query("begin isolation level repeatable read read only");
      input = await loadScoreInputs(
        client,
        args.run ? String(args.run) : undefined,
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const runId = input.run.run_id;
    const { metrics, counts: m, failures, ...metadata } = scoreRun(input);
    await persistScorecard(db, runId, variant, {
      metrics,
      counts: m,
      failures,
      ...metadata,
    });
    console.log(`\nscorecard  run ${runId}  variant ${variant}`);
    console.table(
      Object.entries(metrics).map(([metric, value]) => ({ metric, value })),
    );
    console.log(`raw counts: ${JSON.stringify(m)}`);
    if (failures.length) {
      console.log(`\n${failures.length} failures, first 12:`);
      console.table(failures.slice(0, 12));
    }
  } finally {
    await db.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
