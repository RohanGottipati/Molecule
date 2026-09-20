#!/usr/bin/env node
// Writes a blank label sheet for one reviewer. Every field is null, so the sheet
// FAILS validation until a human has actually decided each document; nothing
// here can be mistaken for "labelled as irrelevant".
//
//   node rox_data/benchmark/template.mjs --manifest=... --reviewer=reviewer-a \
//     --output=.molecule-data/order3/reviewer-a.json
import { BENCHMARK_VERSION, SCENARIO_ID, validateManifest } from "./schema.mjs";
import { assertPrivatePath, parseArgs, readJson, writeNew } from "./cli.mjs";

export function blankLabels(manifest, reviewerId) {
  validateManifest(manifest);
  return {
    version: BENCHMARK_VERSION,
    scenarioId: SCENARIO_ID,
    reviewerId,
    completedAt: null,
    labels: manifest.documents.map((d) => ({
      documentId: d.documentId,
      relevant: null,
      supplier: null,
      capability: null,
      availability: null,
      capacity: null,
      period: null,
      effectiveWindow: null,
      observedAt: null,
      evidence: null,
      expectedHandling: null,
      notes: null,
      adjudication: null,
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(
    process.argv.slice(2),
    ["manifest", "reviewer", "output"],
    ["manifest", "reviewer", "output"],
  );
  assertPrivatePath(args.output);
  await writeNew(
    args.output,
    blankLabels(await readJson(args.manifest), args.reviewer),
  );
  console.log(
    JSON.stringify({ written: args.output, reviewer: args.reviewer }),
  );
}
