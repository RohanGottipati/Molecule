// All fixtures here are synthetic test data. The real bundle is private and
// lives outside version control.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BENCHMARK_VERSION,
  SCENARIO_ID,
  validateBundle,
  validateLabelSet,
} from "../benchmark/schema.mjs";
import { scoreBenchmark, sanitize } from "../benchmark/scoring.mjs";
import { compareReviewers, cohensKappa } from "../benchmark/compare.mjs";
import { blankLabels } from "../benchmark/template.mjs";
import { buildManifest } from "../benchmark/init.mjs";
import { assertPrivatePath } from "../benchmark/cli.mjs";

const sha = (n) => String(n).padStart(64, "0");
const auth = {
  authorized: true,
  basis: "test fixture",
  confirmedBy: "tester",
  confirmedAt: "2026-09-20T00:00:00.000Z",
};
const doc = (n) => ({
  documentId: `doc-00${n}`,
  path: `doc-00${n}.txt`,
  sha256: sha(n),
  byteLength: 10,
  mediaType: "text/plain",
  sourceKind: "message",
  chainId: `chain-${n}`,
  authorization: auth,
  deidentification: { status: "complete", checkedBy: "tester" },
});
const manifest = (count = 2) => ({
  version: BENCHMARK_VERSION,
  scenarioId: SCENARIO_ID,
  classification: "real_authorized",
  createdAt: "2026-09-20T00:00:00.000Z",
  supplierKey: "supplier-001",
  capabilityKey: "capability-embroidery",
  documents: Array.from({ length: count }, (_, i) => doc(i + 1)),
});
const cap = (value, unit = "pieces") => ({
  status: "exact",
  value,
  minimum: null,
  maximum: null,
  unit,
  qualifier: null,
});
const unknownCap = {
  status: "unknown",
  value: null,
  minimum: null,
  maximum: null,
  unit: null,
  qualifier: null,
};
const claimLabel = (id, value = 100, period = "day") => ({
  documentId: id,
  relevant: true,
  supplier: { status: "known", key: "supplier-001" },
  capability: { status: "known", key: "capability-embroidery" },
  availability: "available",
  capacity: cap(value),
  period,
  effectiveWindow: { status: "unknown", start: null, end: null },
  observedAt: null,
  evidence: [{ text: `${value} a ${period}`, locator: "body" }],
  expectedHandling: "claim",
  notes: null,
  adjudication: null,
});
const reviewLabel = (id) => ({
  ...claimLabel(id, 50, "unknown"),
  period: "unknown",
  availability: "unknown",
  expectedHandling: "needs_review",
});
const labels = (reviewerId, list, adjudication = null) => ({
  version: BENCHMARK_VERSION,
  scenarioId: SCENARIO_ID,
  reviewerId,
  completedAt: "2026-09-20T00:00:00.000Z",
  labels: list.map((l) => ({ ...l, adjudication })),
});
const adj = labels(
  "adjudicator",
  [claimLabel("doc-001"), reviewLabel("doc-002")],
  {
    reviewers: ["a", "b"],
    notes: null,
  },
);
const pred = (over = {}) => ({
  handling: "claim",
  supplier: { status: "known", key: "supplier-001" },
  capability: { status: "known", key: "capability-embroidery" },
  availability: "available",
  capacity: cap(100),
  period: "day",
  effectiveWindow: { status: "unknown", start: null, end: null },
  normalized: { value: 100, unit: "units/day" },
  evidence: [{ text: "100 a day" }],
  ...over,
});
const run = (documents) => ({
  version: BENCHMARK_VERSION,
  scenarioId: SCENARIO_ID,
  runId: "run-1",
  documents,
});
const score = (documents, sources = {}) =>
  scoreBenchmark({
    manifest: manifest(),
    adjudicated: adj,
    predictions: run(documents),
    sources,
  });

const perfect = [
  { documentId: "doc-001", status: "completed", predictions: [pred()] },
  {
    documentId: "doc-002",
    status: "completed",
    predictions: [
      pred({
        handling: "needs_review",
        period: "unknown",
        availability: "unknown",
        capacity: cap(50),
        normalized: null,
      }),
    ],
  },
];

test("a perfect run scores 100% with no unsafe promotions", () => {
  const r = score(perfect, { "doc-001": "we do 100 a day" });
  assert.equal(r.metrics.handling_accuracy_pct, 100);
  assert.equal(r.metrics.unsafe_promotions, 0);
  assert.equal(r.metrics.attribution_exact_pct, 100);
  assert.equal(r.metrics.normalization_accuracy_pct, 100);
  assert.equal(r.metrics.evidence_unsupported_pct, 0);
  assert.deepEqual(r.failures, []);
});

test("a document missing from the run is a complete failure, not a smaller population", () => {
  const r = score([perfect[0]]);
  assert.equal(r.counts.documents.selected, 2);
  assert.equal(r.counts.documents.missing_from_run, 1);
  assert.equal(r.metrics.completion_pct, 50);
  assert.equal(r.metrics.handling_accuracy_pct, 50);
  assert.ok(
    r.failures.some(
      (f) =>
        f.documentId === "doc-002" &&
        f.categories.includes("no_attempt_recorded"),
    ),
  );
});

test("a failed attempt on a relevant document lowers recall and is never a true negative", () => {
  const r = score([
    { documentId: "doc-001", status: "failed", predictions: [] },
    perfect[1],
  ]);
  assert.equal(r.metrics.relevance_recall_pct, 50);
  assert.equal(r.counts.relevance.failed_relevant, 1);
  assert.equal(r.counts.relevance.tn, 0);
});

test("promoting a claim the label says needs review is reported as unsafe", () => {
  const bad = [
    perfect[0],
    {
      documentId: "doc-002",
      status: "completed",
      predictions: [pred({ capacity: cap(50), period: "day" })],
    },
  ];
  const r = score(bad);
  assert.equal(r.metrics.unsafe_promotions, 1);
  assert.ok(
    r.failures
      .find((f) => f.documentId === "doc-002")
      .categories.includes("UNSAFE_PROMOTION"),
  );
});

test("wrong supplier is worse than abstaining, and both fail attribution", () => {
  const wrong = score([
    {
      documentId: "doc-001",
      status: "completed",
      predictions: [pred({ supplier: { status: "known", key: "other" } })],
    },
    perfect[1],
  ]);
  assert.equal(wrong.counts.attribution.supplier.wrong, 1);
  const abstain = score([
    {
      documentId: "doc-001",
      status: "completed",
      predictions: [pred({ supplier: { status: "unknown", key: null } })],
    },
    perfect[1],
  ]);
  assert.equal(abstain.counts.attribution.supplier.abstained, 1);
  assert.equal(wrong.metrics.supplier_accuracy_pct, 50);
  assert.equal(abstain.metrics.supplier_accuracy_pct, 50);
  assert.equal(wrong.metrics.wrong_attribution_count, 1);
  assert.equal(abstain.metrics.wrong_attribution_count, 0);
});

test("a conversion where the source supports none is an error", () => {
  const r = score([
    perfect[0],
    {
      documentId: "doc-002",
      status: "completed",
      predictions: [
        pred({
          handling: "needs_review",
          capacity: cap(50),
          period: "unknown",
          availability: "unknown",
          normalized: { value: 50, unit: "units/day" },
        }),
      ],
    },
  ]);
  assert.equal(r.metrics.unsupported_conversions, 1);
});

test("extra predictions on a document count against the run", () => {
  const r = score([
    {
      documentId: "doc-001",
      status: "completed",
      predictions: [pred(), pred({ capacity: cap(999) })],
    },
    perfect[1],
  ]);
  assert.equal(r.metrics.extra_predictions, 1);
});

test("the prediction matching the labelled value is the one scored", () => {
  const r = score([
    {
      documentId: "doc-001",
      status: "completed",
      predictions: [
        pred({
          capacity: cap(999),
          normalized: { value: 999, unit: "units/day" },
        }),
        pred(),
      ],
    },
    perfect[1],
  ]);
  assert.equal(r.metrics.capacity_exact_accuracy_pct, 100);
});

test("evidence absent from the source is flagged", () => {
  const r = score(perfect, { "doc-001": "nothing relevant here" });
  assert.equal(r.metrics.evidence_unsupported_pct, 100);
});

test("predictions for documents outside the manifest are rejected", () => {
  assert.throws(
    () =>
      score([{ documentId: "doc-999", status: "completed", predictions: [] }]),
    /not in the manifest/,
  );
  assert.throws(
    () => score([{ documentId: "doc-001", status: "maybe", predictions: [] }]),
    /completed\|failed\|skipped/,
  );
});

test("sanitized report has categories and counts only", () => {
  const r = sanitize(score([perfect[0]]));
  assert.equal(r.failures, undefined);
  assert.ok(r.failureCategories.no_attempt_recorded >= 1);
  assert.ok(!JSON.stringify(r).includes("doc-002"));
});

test("reviewer comparison finds disagreements, kappa and forces adjudication notes", () => {
  const a = labels("a", [claimLabel("doc-001", 100), reviewLabel("doc-002")]);
  const b = labels("b", [claimLabel("doc-001", 120), reviewLabel("doc-002")]);
  const { report, skeleton } = compareReviewers({
    manifest: manifest(),
    reviewerA: a,
    reviewerB: b,
  });
  assert.equal(report.disagreeingDocuments, 1);
  assert.deepEqual(report.disagreements[0], {
    documentId: "doc-001",
    fields: ["capacity"],
  });
  assert.equal(report.agreementByField.expectedHandling.kappa, 1);
  // The skeleton cannot pass validation until a human writes the note.
  assert.throws(
    () =>
      validateBundle({
        manifest: manifest(),
        reviewers: [a, b],
        adjudicated: skeleton,
      }),
    /disagreement requires adjudication notes/,
  );
  skeleton.labels[0].adjudication.notes =
    "checked the spreadsheet cell; 100 is correct";
  assert.equal(
    validateBundle({
      manifest: manifest(),
      reviewers: [a, b],
      adjudicated: skeleton,
    }).disagreements,
    1,
  );
});

test("identical reviewers are rejected as not independent", () => {
  const a = labels("same", [claimLabel("doc-001"), reviewLabel("doc-002")]);
  assert.throws(
    () =>
      compareReviewers({ manifest: manifest(), reviewerA: a, reviewerB: a }),
    /distinct/,
  );
});

test("kappa handles perfect, chance-level and degenerate agreement", () => {
  assert.equal(cohensKappa(["x", "y"], ["x", "y"]), 1);
  assert.equal(cohensKappa(["x", "x"], ["x", "x"]), 1);
  assert.equal(cohensKappa(["x", "y", "x", "y"], ["y", "x", "x", "y"]), 0);
});

test("a blank reviewer template fails validation until labelled", () => {
  const blank = blankLabels(manifest(), "reviewer-a");
  assert.equal(blank.labels.length, 2);
  assert.throws(() => validateLabelSet(blank));
});

test("private outputs must live under .molecule-data", () => {
  assert.doesNotThrow(() =>
    assertPrivatePath("/repo/.molecule-data/order3/x.json"),
  );
  assert.throws(
    () => assertPrivatePath("/repo/docs/evidence/x.json"),
    /\.molecule-data/,
  );
});

test("manifest builder hashes files and refuses unlisted or missing documents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rox-init-"));
  try {
    await writeFile(join(dir, "one.txt"), "we do 100 a day");
    const entry = (file) => ({
      file,
      sourceKind: "message",
      chainId: "chain-1",
      authorization: auth,
      deidentification: { status: "complete", checkedBy: "tester" },
    });
    const sheet = {
      supplierKey: "supplier-001",
      capabilityKey: "capability-embroidery",
      documents: [entry("one.txt")],
    };
    const built = await buildManifest({ raw: dir, sheet });
    assert.equal(built.documents[0].documentId, "doc-001");
    assert.match(built.documents[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(built.documents[0].mediaType, "text/plain");
    await writeFile(join(dir, "two.txt"), "unlisted");
    await assert.rejects(
      () => buildManifest({ raw: dir, sheet }),
      /not authorized in the sheet/,
    );
    await rm(join(dir, "two.txt"));
    sheet.documents.push(entry("gone.txt"));
    await assert.rejects(
      () => buildManifest({ raw: dir, sheet }),
      /missing from raw/,
    );
    sheet.documents[0].authorization = { ...auth, authorized: false };
    sheet.documents.pop();
    await assert.rejects(
      () => buildManifest({ raw: dir, sheet }),
      /explicitly true/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
