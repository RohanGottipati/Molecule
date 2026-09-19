#!/usr/bin/env node
// Loads the corpus ground truth into rox_truth. Deliberately a separate command
// from the pipeline: nothing in pipeline/run.mjs reads this table, and scoring
// is the only consumer.
//
//   node --env-file=../.env --env-file=../.env.local pipeline/load-truth.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connect, transaction } from "./db.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const corpus = args.corpus ? String(args.corpus) : join(HERE, "..", "corpus");

const manifest = JSON.parse(await readFile(join(corpus, "manifest.json"), "utf8"));
const rows = (await readFile(join(corpus, "truth.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));

const db = await connect({ max: 2 });
const n = await transaction(db, async (client) => {
  await client.query("delete from rox_truth where batch_id = $1", [manifest.batchId]);
  let loaded = 0;
  for (const t of rows) {
    await client.query(
    `insert into rox_truth
       (truth_id, batch_id, source_path, merchant_id, field, true_value, true_unit, observed_at,
        should_quarantine, should_conflict, is_injection, chaos)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (truth_id) do nothing`,
    [t.truthId, t.batchId, t.sourcePath, t.merchantId, t.field,
     JSON.stringify({ stated: t.statedValue, statedUnit: t.statedUnit, true: t.trueValue, trueUnit: t.trueUnit, expect: t.expect, isOutlier: t.isOutlier }),
       t.trueUnit, t.observedAt, t.shouldQuarantine, t.shouldConflict, t.isInjection, t.chaos],
    );
    loaded += 1;
  }
  return loaded;
});
console.log(`loaded ${n} truth rows for batch ${manifest.batchId}`);
await db.end();
