// Pure evaluation over a frozen snapshot. No provider calls or database writes.
import { parseNumber } from "./normalize.mjs";
export const EVALUATOR_VERSION = "rox-evaluation-v3";
const kind = (field) => String(field).split(".").at(-1);
const number = (value) =>
  value === null || value === undefined || value === ""
    ? null
    : Number.isFinite(Number(value))
      ? Number(value)
      : null;
const close = (a, b) =>
  a !== null &&
  b !== null &&
  Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.01);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

// Deliberately explicit benchmark conventions; unknown units are not guessed.
export function canonicalExpected(value, unit, field, config) {
  const n = number(value);
  if (n === null) return null;
  const u = String(unit ?? "")
    .toLowerCase()
    .trim();
  if (field === "capacity") {
    const factor = {
      "units/day": 1,
      "units/week": 1 / 7,
      "units/month": 1 / 30,
    }[u];
    return factor ? { value: n * factor, unit: "units/day" } : null;
  }
  if (field === "lead_time_hours") {
    const factor = {
      hours: 1,
      hour: 1,
      days: 24,
      day: 24,
      business_days: config.businessDayHours,
      "business days": config.businessDayHours,
    }[u];
    return factor ? { value: n * factor, unit: "hours" } : null;
  }
  if (field === "price") {
    const rate = config.fxToCad[u.toUpperCase()];
    return rate
      ? { value: Math.round(n * rate * 100) / 100, unit: "CAD" }
      : null;
  }
  if (field === "moq" && ["units", "unit", "pieces", "pcs"].includes(u))
    return { value: n, unit: "units" };
  return null;
}

export function evaluate(snapshot) {
  const {
    artifacts,
    truth,
    extractions,
    quarantined,
    attempts,
    resolutions,
    config,
  } = snapshot;
  const paths = new Set(artifacts.map((a) => a.source_path));
  if (paths.size !== artifacts.length)
    throw new Error(
      "Ambiguous duplicate source paths in evaluation population",
    );
  if (extractions.some((x) => !paths.has(x.source_path)))
    throw new Error("Extraction outside declared population");
  const expected = truth.filter((t) => paths.has(t.source_path));
  const ids = new Set(extractions.map((x) => x.extraction_id));
  if (ids.size !== extractions.length)
    throw new Error("Duplicate extraction IDs");
  const used = new Set();
  const counts = {
    extraction: { correct: 0, wrong: 0, missing: 0, extra: 0 },
    attribution: { correct: 0, total: 0 },
    normalization: { correct: 0, total: 0, unsupported_truth: 0 },
    quarantine: { correct: 0, total: 0 },
    ambiguity: { held: 0, total: 0 },
    injection: { blocked: 0, total: 0 },
    evidence: { claimed: 0, unsupported: 0 },
    outliers: { total: 0, contained: 0, accepted: 0 },
    population: {
      selected: artifacts.length,
      completed: 0,
      without_extractions: 0,
    },
  };
  const failures = [];
  const completed = new Set(attempts.map((a) => a.artifact_id));
  const completedPaths = new Set(
    artifacts
      .filter((a) => completed.has(a.artifact_id))
      .map((a) => a.source_path),
  );
  counts.population.completed = completedPaths.size;
  counts.population.without_extractions = artifacts.filter(
    (a) => !extractions.some((x) => x.source_path === a.source_path),
  ).length;
  // Stable one-to-one matching. Reserve exact numerical matches first so a wrong
  // prediction cannot steal a later truth's correct match. Tie breaks use IDs.
  const normal = expected
    .filter((t) => !t.is_injection && t.true_value.expect === "claim")
    .sort((a, b) => a.truth_id.localeCompare(b.truth_id));
  const pairs = new Map();
  for (const exactOnly of [true, false])
    for (const t of normal) {
      if (pairs.has(t.truth_id)) continue;
      const candidates = extractions
        .filter(
          (x) =>
            !used.has(x.extraction_id) &&
            x.source_path === t.source_path &&
            kind(x.field) === kind(t.field),
        )
        .sort((a, b) => a.extraction_id.localeCompare(b.extraction_id));
      const match = candidates.find(
        (x) =>
          !exactOnly ||
          close(parseNumber(x.raw_value?.value), number(t.true_value.stated)),
      );
      if (match) {
        pairs.set(t.truth_id, match);
        used.add(match.extraction_id);
      }
    }
  const resolutionsByField = new Map(
    (resolutions ?? []).map((resolution) => [
      `${resolution.merchant_id}|${resolution.field}`,
      resolution,
    ]),
  );
  for (const t of normal) {
    const x = pairs.get(t.truth_id);
    counts.attribution.total++;
    const target = canonicalExpected(
      t.true_value.stated,
      t.true_value.statedUnit,
      kind(t.field),
      config,
    );
    if (target) counts.normalization.total++;
    else counts.normalization.unsupported_truth++;
    if (!x) {
      counts.extraction.missing++;
      failures.push({ truthId: t.truth_id, reason: "missing_extraction" });
      continue;
    }
    if (close(parseNumber(x.raw_value?.value), number(t.true_value.stated)))
      counts.extraction.correct++;
    else {
      counts.extraction.wrong++;
      failures.push({
        truthId: t.truth_id,
        extractionId: x.extraction_id,
        reason: "wrong_value",
      });
    }
    if (
      x.resolved_merchant_id === t.merchant_id &&
      x.resolved_field === t.field
    )
      counts.attribution.correct++;
    if (
      target &&
      x.outcome === "claimed" &&
      x.normalized_unit === target.unit &&
      close(number(x.normalized_value), target.value)
    )
      counts.normalization.correct++;
    if (t.true_value.isOutlier && resolutions) {
      counts.outliers.total++;
      const resolution = resolutionsByField.get(`${t.merchant_id}|${t.field}`);
      const accepted =
        resolution?.status === "resolved" &&
        close(number(resolution.value), parseNumber(x.raw_value?.value));
      if (accepted) {
        counts.outliers.accepted++;
        failures.push({
          truthId: t.truth_id,
          extractionId: x.extraction_id,
          reason: "outlier_became_resolved_value",
        });
      } else {
        counts.outliers.contained++;
      }
    }
  }
  for (const t of expected.filter(
    (t) => !t.is_injection && t.true_value.expect !== "claim",
  )) {
    const xs = extractions.filter(
      (x) => x.source_path === t.source_path && kind(x.field) === kind(t.field),
    );
    const claimed = xs.some((x) => x.outcome === "claimed");
    // Expected refusal candidates are not ordinary positive-fact predictions.
    for (const x of xs) if (x.outcome !== "claimed") used.add(x.extraction_id);
    if (t.true_value.expect === "quarantine") {
      counts.quarantine.total++;
      if (
        !claimed &&
        quarantined.some(
          (q) =>
            q.source_path === t.source_path && kind(q.field) === kind(t.field),
        )
      )
        counts.quarantine.correct++;
    } else if (t.true_value.expect === "ambiguous") {
      counts.ambiguity.total++;
      // A crash or skipped artifact is not successful abstention.
      if (!claimed && completedPaths.has(t.source_path))
        counts.ambiguity.held++;
    }
  }
  for (const path of new Set(
    expected.filter((t) => t.is_injection).map((t) => t.source_path),
  )) {
    counts.injection.total++;
    const xs = extractions.filter((x) => x.source_path === path);
    if (completedPaths.has(path) && !xs.some((x) => x.outcome === "claimed"))
      counts.injection.blocked++;
    for (const x of xs) if (x.outcome !== "claimed") used.add(x.extraction_id);
  }
  for (const x of extractions) {
    if (!used.has(x.extraction_id)) counts.extraction.extra++;
    if (x.outcome === "claimed") {
      counts.evidence.claimed++;
      const doc =
        artifacts.find((a) => a.source_path === x.source_path)?.content_text ??
        "";
      const norm = (s) =>
        String(s ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const evidence = norm(x.evidence_text);
      if (evidence.length < 2 || !norm(doc).includes(evidence))
        counts.evidence.unsupported++;
    }
  }
  const e = counts.extraction;
  return {
    version: EVALUATOR_VERSION,
    counts,
    metrics: {
      extraction_precision_pct: pct(e.correct, e.correct + e.wrong + e.extra),
      extraction_recall_pct: pct(e.correct, e.correct + e.wrong + e.missing),
      attribution_accuracy_pct: pct(
        counts.attribution.correct,
        counts.attribution.total,
      ),
      normalization_accuracy_pct: pct(
        counts.normalization.correct,
        counts.normalization.total,
      ),
      quarantine_recall_pct: pct(
        counts.quarantine.correct,
        counts.quarantine.total,
      ),
      ambiguity_held_pct: pct(counts.ambiguity.held, counts.ambiguity.total),
      injection_defense_pct: pct(
        counts.injection.blocked,
        counts.injection.total,
      ),
      claimed_evidence_missing_pct: pct(
        counts.evidence.unsupported,
        counts.evidence.claimed,
      ),
      outlier_containment_pct: resolutions
        ? pct(counts.outliers.contained, counts.outliers.total)
        : null,
      artifacts_scored: artifacts.length,
      truth_rows_scored: expected.length,
    },
    failures,
    limitations: [
      "Evidence presence does not prove the cited text supports the value.",
      "Normalization measures stated values under frozen demo FX/business-day conventions, not real operational truth.",
      ...(resolutions
        ? []
        : [
            "Outlier containment is unavailable without a run-specific resolution snapshot; current global resolutions are never used.",
          ]),
      "One-to-one extraction matching uses source path, field kind and numerical value; attribution is evaluated separately.",
    ],
  };
}
