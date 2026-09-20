#!/usr/bin/env node
// Compares the two independent label sets: where they disagree, how much, and
// an adjudication skeleton. Run this BEFORE anyone looks at pipeline output.
//
//   node rox_data/benchmark/compare.mjs --manifest=... --reviewer-a=... --reviewer-b=... \
//     --report=.molecule-data/order3/disagreements.json \
//     --skeleton=.molecule-data/order3/adjudicated.json
import {
  BENCHMARK_VERSION,
  SCENARIO_ID,
  validateLabelSet,
  validateManifest,
} from "./schema.mjs";
import { assertPrivatePath, parseArgs, readJson, writeNew } from "./cli.mjs";

const FIELDS = [
  "relevant",
  "supplier",
  "capability",
  "availability",
  "capacity",
  "period",
  "effectiveWindow",
  "observedAt",
  "expectedHandling",
];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function cohensKappa(a, b) {
  const n = a.length;
  if (!n) return null;
  const cats = [...new Set([...a, ...b])];
  const observed = a.filter((x, i) => x === b[i]).length / n;
  const expected = cats.reduce(
    (s, c) =>
      s +
      (a.filter((x) => x === c).length / n) *
        (b.filter((x) => x === c).length / n),
    0,
  );
  return expected === 1
    ? 1
    : Math.round(((observed - expected) / (1 - expected)) * 1000) / 1000;
}

export function compareReviewers({
  manifest,
  reviewerA,
  reviewerB,
  now = new Date(),
}) {
  validateManifest(manifest);
  validateLabelSet(reviewerA);
  validateLabelSet(reviewerB);
  if (reviewerA.reviewerId === reviewerB.reviewerId)
    throw new Error("reviewers must be distinct people");
  const a = new Map(reviewerA.labels.map((l) => [l.documentId, l]));
  const b = new Map(reviewerB.labels.map((l) => [l.documentId, l]));
  const perField = Object.fromEntries(
    FIELDS.map((f) => [f, { agree: 0, total: 0 }]),
  );
  const disagreements = [];
  const skeletonLabels = [];
  for (const doc of manifest.documents) {
    const la = a.get(doc.documentId);
    const lb = b.get(doc.documentId);
    if (!la || !lb)
      throw new Error(`${doc.documentId}: not labelled by both reviewers`);
    const fields = FIELDS.filter((f) => !same(la[f], lb[f]));
    for (const f of FIELDS) {
      perField[f].total++;
      if (!fields.includes(f)) perField[f].agree++;
    }
    if (fields.length)
      disagreements.push({ documentId: doc.documentId, fields });
    skeletonLabels.push({
      ...la,
      // Disagreements start from reviewer A's label ONLY as a draft; the
      // required adjudication note is what makes a human decide.
      adjudication: {
        reviewers: [reviewerA.reviewerId, reviewerB.reviewerId],
        notes: null,
      },
    });
  }
  const kappaOf = (f) =>
    cohensKappa(
      manifest.documents.map((d) => JSON.stringify(a.get(d.documentId)[f])),
      manifest.documents.map((d) => JSON.stringify(b.get(d.documentId)[f])),
    );
  return {
    report: {
      documents: manifest.documents.length,
      disagreeingDocuments: disagreements.length,
      agreementByField: Object.fromEntries(
        FIELDS.map((f) => [f, { ...perField[f], kappa: kappaOf(f) }]),
      ),
      disagreements,
    },
    skeleton: {
      version: BENCHMARK_VERSION,
      scenarioId: SCENARIO_ID,
      reviewerId: "adjudicator",
      completedAt: now.toISOString(),
      labels: skeletonLabels,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(
    process.argv.slice(2),
    ["manifest", "reviewer-a", "reviewer-b", "report", "skeleton"],
    ["manifest", "reviewer-a", "reviewer-b", "report"],
  );
  assertPrivatePath(args.report);
  const { report, skeleton } = compareReviewers({
    manifest: await readJson(args.manifest),
    reviewerA: await readJson(args["reviewer-a"]),
    reviewerB: await readJson(args["reviewer-b"]),
  });
  await writeNew(args.report, report);
  if (args.skeleton) {
    assertPrivatePath(args.skeleton);
    await writeNew(args.skeleton, skeleton);
  }
  console.log(
    JSON.stringify({
      documents: report.documents,
      disagreeing: report.disagreeingDocuments,
    }),
  );
}
