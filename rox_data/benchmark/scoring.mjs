// Scores pipeline predictions against the ADJUDICATED labels of the private
// real-document bundle. Pure: no database, provider or filesystem access.
//
// Design rules (Order 1 + Order 2):
//   * The selected population never shrinks. A document with no completed
//     attempt is a complete failure, not an absent row, and a failed document
//     is never counted as a successful abstention.
//   * One document carries one labelled fact. Extra predictions on a document
//     are counted against precision, never silently ignored.
//   * Promoting a claim where the label says review/quarantine/none is the
//     most serious error and is reported on its own line.
//   * Normalization is scored only where the source supports a conversion; a
//     converted value where none is supported is an error, not a bonus.
//   * Reports carry IDs and categories, never source text.

import {
  BENCHMARK_VERSION,
  SCENARIO_ID,
  validateLabelSet,
  validateManifest,
} from "./schema.mjs";

export const SCORER_VERSION = "apparel-capacity-scorer-v1";
const PERIOD_DAYS = { day: 1, week: 7, month: 30 };
const HANDLING = ["claim", "needs_review", "quarantine", "no_relevant_fact"];
const STATUS = new Set(["completed", "failed", "skipped"]);

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const lower = (v) => (v == null ? null : String(v).trim().toLowerCase());
const num = (a, b) =>
  a === b ||
  (a != null &&
    b != null &&
    Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9));

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

export function validatePredictions(predictions, manifest) {
  if (!predictions || typeof predictions !== "object")
    fail("predictions", "expected an object");
  if (predictions.version !== BENCHMARK_VERSION)
    fail("predictions.version", `expected ${BENCHMARK_VERSION}`);
  if (predictions.scenarioId !== SCENARIO_ID)
    fail("predictions.scenarioId", `expected ${SCENARIO_ID}`);
  if (typeof predictions.runId !== "string" || !predictions.runId)
    fail("predictions.runId", "expected a run ID");
  if (!Array.isArray(predictions.documents))
    fail("predictions.documents", "expected an array");
  const known = new Set(manifest.documents.map((d) => d.documentId));
  const seen = new Set();
  predictions.documents.forEach((doc, i) => {
    const p = `predictions.documents[${i}]`;
    if (!known.has(doc.documentId))
      fail(p, `document ${doc.documentId} is not in the manifest`);
    if (seen.has(doc.documentId)) fail(p, "duplicate document ID");
    seen.add(doc.documentId);
    if (!STATUS.has(doc.status))
      fail(`${p}.status`, "expected completed|failed|skipped");
    if (!Array.isArray(doc.predictions))
      fail(`${p}.predictions`, "expected an array");
    for (const [j, pred] of doc.predictions.entries())
      if (!HANDLING.includes(pred.handling))
        fail(
          `${p}.predictions[${j}].handling`,
          `expected one of ${HANDLING.join(", ")}`,
        );
  });
}

const identityEqual = (a, b) =>
  a?.status === b?.status && (a?.key ?? null) === (b?.key ?? null);
const capacityValueEqual = (a, b) =>
  a?.status === b?.status &&
  num(a?.value ?? null, b?.value ?? null) &&
  num(a?.minimum ?? null, b?.minimum ?? null) &&
  num(a?.maximum ?? null, b?.maximum ?? null);
const capacityEqual = (a, b) =>
  capacityValueEqual(a, b) &&
  lower(a?.unit) === lower(b?.unit) &&
  lower(a?.qualifier) === lower(b?.qualifier);
const windowEqual = (a, b) =>
  a?.status === b?.status &&
  (a?.start ?? null) === (b?.start ?? null) &&
  (a?.end ?? null) === (b?.end ?? null);

const RANK = { claim: 3, needs_review: 2, quarantine: 1, no_relevant_fact: 0 };

/** The prediction that answers this document's single labelled fact. */
function choose(predictions, label) {
  const facts = predictions.filter((p) => p.handling !== "no_relevant_fact");
  if (!facts.length) return { chosen: null, extras: 0 };
  const sorted = [...facts].sort((a, b) => {
    const am = capacityValueEqual(a.capacity, label.capacity) ? 1 : 0;
    const bm = capacityValueEqual(b.capacity, label.capacity) ? 1 : 0;
    return bm - am || RANK[b.handling] - RANK[a.handling];
  });
  return { chosen: sorted[0], extras: sorted.length - 1 };
}

const evidenceNorm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * @param sources optional map documentId -> extracted text, for evidence checks;
 *   binary media the caller could not read are simply absent (unscorable).
 */
export function scoreBenchmark({
  manifest,
  adjudicated,
  predictions,
  sources = {},
}) {
  validateManifest(manifest);
  validateLabelSet(adjudicated, { adjudicated: true });
  validatePredictions(predictions, manifest);
  const labels = new Map(adjudicated.labels.map((l) => [l.documentId, l]));
  const byDoc = new Map(predictions.documents.map((d) => [d.documentId, d]));

  const c = {
    documents: { selected: 0, completed: 0, failed: 0, missing_from_run: 0 },
    relevance: {
      tp: 0,
      fp: 0,
      fn: 0,
      tn: 0,
      failed_relevant: 0,
      failed_irrelevant: 0,
    },
    handling: { correct: 0, total: 0 },
    safety: {
      unsafe_promotions: 0,
      non_claim_labels: 0,
      missed_claims: 0,
      claim_labels: 0,
    },
    attribution: {
      supplier: {
        correct: 0,
        abstained: 0,
        wrong: 0,
        total: 0,
        false_attribution: 0,
        unknown_labels: 0,
      },
      capability: {
        correct: 0,
        abstained: 0,
        wrong: 0,
        total: 0,
        false_attribution: 0,
        unknown_labels: 0,
      },
      both_correct: 0,
      both_total: 0,
    },
    fields: {
      availability: { correct: 0, total: 0 },
      capacity_value: { correct: 0, total: 0 },
      capacity_exact: { correct: 0, total: 0 },
      period: { correct: 0, total: 0 },
      window: { correct: 0, total: 0 },
    },
    normalization: {
      correct: 0,
      total: 0,
      unsupported_converted: 0,
      unsupported_total: 0,
    },
    evidence: { checkable: 0, unsupported: 0 },
    extra_predictions: 0,
  };
  const failures = [];

  for (const doc of manifest.documents) {
    const id = doc.documentId;
    const label = labels.get(id);
    const entry = byDoc.get(id);
    const cats = [];
    c.documents.selected++;
    if (!entry) c.documents.missing_from_run++;
    const completed = entry?.status === "completed";
    if (completed) c.documents.completed++;
    else {
      c.documents.failed++;
      cats.push(entry ? `attempt_${entry.status}` : "no_attempt_recorded");
    }
    const { chosen, extras } = completed
      ? choose(entry.predictions, label)
      : { chosen: null, extras: 0 };
    c.extra_predictions += extras;
    if (extras) cats.push("extra_predictions");
    const predicted = chosen?.handling ?? "no_relevant_fact";

    // relevance (failed documents are never a true negative)
    if (!completed) {
      if (label.relevant) c.relevance.failed_relevant++;
      else c.relevance.failed_irrelevant++;
    } else if (label.relevant && predicted !== "no_relevant_fact")
      c.relevance.tp++;
    else if (label.relevant) {
      c.relevance.fn++;
      cats.push("missed_relevant_document");
    } else if (predicted !== "no_relevant_fact") {
      c.relevance.fp++;
      cats.push("false_relevant_document");
    } else c.relevance.tn++;

    // handling + safety
    c.handling.total++;
    if (completed && predicted === label.expectedHandling) c.handling.correct++;
    else cats.push(`handling_${predicted}_vs_${label.expectedHandling}`);
    if (label.expectedHandling === "claim") {
      c.safety.claim_labels++;
      if (predicted !== "claim") {
        c.safety.missed_claims++;
        cats.push("missed_claim");
      }
    } else {
      c.safety.non_claim_labels++;
      if (predicted === "claim") {
        c.safety.unsafe_promotions++;
        cats.push("UNSAFE_PROMOTION");
      }
    }

    // attribution
    const both = { s: false, c: false };
    for (const [key, group] of [
      ["supplier", "s"],
      ["capability", "c"],
    ]) {
      const a = c.attribution[key];
      const want = label[key];
      const got = chosen?.[key] ?? { status: "unknown", key: null };
      if (want.status === "known") {
        a.total++;
        if (completed && identityEqual(got, want)) {
          a.correct++;
          both[group] = true;
        } else if (!completed || got.status === "unknown") {
          a.abstained++;
          cats.push(`${key}_abstained`);
        } else {
          a.wrong++;
          cats.push(`${key}_wrong`);
        }
      } else if (label.relevant) {
        a.unknown_labels++;
        if (chosen && got.status === "known") {
          a.false_attribution++;
          cats.push(`${key}_false_attribution`);
        }
      }
    }
    if (
      label.supplier.status === "known" &&
      label.capability.status === "known"
    ) {
      c.attribution.both_total++;
      if (both.s && both.c) c.attribution.both_correct++;
    }

    // fields (only for documents that carry a labelled fact)
    if (label.relevant) {
      const f = c.fields;
      f.availability.total++;
      if (completed && chosen?.availability === label.availability)
        f.availability.correct++;
      f.capacity_value.total++;
      f.capacity_exact.total++;
      if (
        completed &&
        chosen &&
        capacityValueEqual(chosen.capacity, label.capacity)
      )
        f.capacity_value.correct++;
      else cats.push("capacity_value_wrong");
      if (completed && chosen && capacityEqual(chosen.capacity, label.capacity))
        f.capacity_exact.correct++;
      f.period.total++;
      if (completed && chosen?.period === label.period) f.period.correct++;
      else cats.push("period_wrong");
      f.window.total++;
      if (
        completed &&
        chosen &&
        windowEqual(chosen.effectiveWindow, label.effectiveWindow)
      )
        f.window.correct++;
      else cats.push("window_wrong");

      // normalization
      const days = PERIOD_DAYS[label.period];
      if (label.capacity.status === "exact" && days) {
        c.normalization.total++;
        const want = label.capacity.value / days;
        const n = chosen?.normalized;
        if (
          completed &&
          n &&
          lower(n.unit) === "units/day" &&
          num(n.value, want)
        )
          c.normalization.correct++;
        else cats.push("normalization_wrong");
      } else if (label.capacity.status !== "unknown") {
        c.normalization.unsupported_total++;
        if (completed && chosen?.normalized != null) {
          c.normalization.unsupported_converted++;
          cats.push("unsupported_conversion");
        }
      }
    }

    // evidence supports what was claimed
    if (completed && chosen?.handling === "claim" && sources[id] != null) {
      for (const ev of chosen.evidence ?? []) {
        c.evidence.checkable++;
        const e = evidenceNorm(ev.text);
        if (e.length < 2 || !evidenceNorm(sources[id]).includes(e)) {
          c.evidence.unsupported++;
          cats.push("evidence_not_in_source");
        }
      }
    }
    if (cats.length)
      failures.push({ documentId: id, categories: [...new Set(cats)] });
  }

  const r = c.relevance;
  const metrics = {
    documents_selected: c.documents.selected,
    documents_completed: c.documents.completed,
    completion_pct: pct(c.documents.completed, c.documents.selected),
    relevance_precision_pct: pct(r.tp, r.tp + r.fp),
    relevance_recall_pct: pct(r.tp, r.tp + r.fn + r.failed_relevant),
    handling_accuracy_pct: pct(c.handling.correct, c.handling.total),
    unsafe_promotions: c.safety.unsafe_promotions,
    unsafe_promotion_pct: pct(
      c.safety.unsafe_promotions,
      c.safety.non_claim_labels,
    ),
    missed_claim_pct: pct(c.safety.missed_claims, c.safety.claim_labels),
    supplier_accuracy_pct: pct(
      c.attribution.supplier.correct,
      c.attribution.supplier.total,
    ),
    capability_accuracy_pct: pct(
      c.attribution.capability.correct,
      c.attribution.capability.total,
    ),
    attribution_exact_pct: pct(
      c.attribution.both_correct,
      c.attribution.both_total,
    ),
    wrong_attribution_count:
      c.attribution.supplier.wrong +
      c.attribution.capability.wrong +
      c.attribution.supplier.false_attribution +
      c.attribution.capability.false_attribution,
    availability_accuracy_pct: pct(
      c.fields.availability.correct,
      c.fields.availability.total,
    ),
    capacity_value_accuracy_pct: pct(
      c.fields.capacity_value.correct,
      c.fields.capacity_value.total,
    ),
    capacity_exact_accuracy_pct: pct(
      c.fields.capacity_exact.correct,
      c.fields.capacity_exact.total,
    ),
    period_accuracy_pct: pct(c.fields.period.correct, c.fields.period.total),
    window_accuracy_pct: pct(c.fields.window.correct, c.fields.window.total),
    normalization_accuracy_pct: pct(
      c.normalization.correct,
      c.normalization.total,
    ),
    unsupported_conversions: c.normalization.unsupported_converted,
    evidence_unsupported_pct: pct(c.evidence.unsupported, c.evidence.checkable),
    extra_predictions: c.extra_predictions,
  };
  return {
    version: BENCHMARK_VERSION,
    scorerVersion: SCORER_VERSION,
    scenarioId: SCENARIO_ID,
    runId: predictions.runId,
    pipeline: predictions.pipeline ?? null,
    counts: c,
    metrics,
    failures,
    limitations: [
      "A small real set exposes failure modes; it does not establish generalization.",
      "Labels are human statements about documents, not verified operational truth.",
      "Evidence presence proves the quote exists in the source, not that it supports the value.",
      "Conflict outcomes need a frozen run-specific resolution snapshot; this scorer does not grade resolution.",
      "Synthetic and real results must be reported separately.",
    ],
  };
}

/** The only shape safe to commit: counts and metrics, no IDs and no source text. */
export function sanitize(report) {
  const { failures, ...rest } = report;
  const categories = {};
  for (const f of failures)
    for (const cat of f.categories)
      categories[cat] = (categories[cat] ?? 0) + 1;
  return { ...rest, failures: undefined, failureCategories: categories };
}
