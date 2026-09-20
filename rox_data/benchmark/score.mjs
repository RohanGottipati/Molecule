#!/usr/bin/env node
// Scores a predictions file against the validated, adjudicated private bundle.
//
//   node rox_data/benchmark/score.mjs --manifest=... --reviewer-a=... --reviewer-b=... \
//     --adjudicated=... --raw=... --predictions=... \
//     --output=.molecule-data/order3/score-<run>.json [--sanitized=docs/evidence/order3-real-score.json]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateBundle, verifyRawFiles } from "./schema.mjs";
import { scoreBenchmark, sanitize } from "./scoring.mjs";
import { assertPrivatePath, parseArgs, readJson, writeNew } from "./cli.mjs";

const TEXT = new Set([
  "message/rfc822",
  "text/plain",
  "text/csv",
  "application/json",
]);
const args = parseArgs(
  process.argv.slice(2),
  [
    "manifest",
    "reviewer-a",
    "reviewer-b",
    "adjudicated",
    "raw",
    "predictions",
    "output",
    "sanitized",
  ],
  [
    "manifest",
    "reviewer-a",
    "reviewer-b",
    "adjudicated",
    "raw",
    "predictions",
    "output",
  ],
);
assertPrivatePath(args.output);
const manifest = await readJson(args.manifest);
const reviewers = [
  await readJson(args["reviewer-a"]),
  await readJson(args["reviewer-b"]),
];
const adjudicated = await readJson(args.adjudicated);
validateBundle({ manifest, reviewers, adjudicated });
await verifyRawFiles(manifest, args.raw);
const sources = {};
for (const d of manifest.documents)
  if (TEXT.has(d.mediaType))
    sources[d.documentId] = await readFile(join(args.raw, d.path), "utf8");
const report = scoreBenchmark({
  manifest,
  adjudicated,
  predictions: await readJson(args.predictions),
  sources,
});
await writeNew(args.output, report);
if (args.sanitized) await writeNew(args.sanitized, sanitize(report));
console.log(
  JSON.stringify({ ...report.metrics, output: args.output }, null, 2),
);
