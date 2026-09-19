#!/usr/bin/env node
// Removes everything one corpus batch produced, so the demo can be run again
// from a clean state. Only touches rows traceable to that batch: claims are
// matched on their source_reference prefix, never by date or by wildcard.
//
//   node --env-file=../.env --env-file=../.env.local pipeline/reset-batch.mjs --batch=rox-full-s42
//   node --env-file=../.env --env-file=../.env.local pipeline/reset-batch.mjs --batch=... --keep-truth

import { connect, transaction } from "./db.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const batchId = String(args.batch ?? "");
if (!batchId) { console.error("--batch=<id> is required"); process.exit(1); }
const prefix = `corpus:${batchId}:%`;

const db = await connect({ max: 2 });
const counts = await transaction(db, async (c) => {
  const n = {};
  const del = async (label, sql, params) => { n[label] = (await c.query(sql, params)).rowCount; };

  // Order is dictated by the foreign keys: extractions point at claims, and
  // quarantine rows point at artifacts, so both go before what they reference.
  await del("reviews", `delete from rox_review_queue where run_id in
    (select run_id from rox_ingest_runs where batch_id = $1)`, [batchId]);
  await del("quarantined", `delete from quarantined_claims where artifact_id in
    (select artifact_id from raw_artifacts where batch_id = $1)`, [batchId]);
  await del("artifacts", `delete from raw_artifacts where batch_id = $1`, [batchId]);  // cascades to extractions
  await del("resolutions", `delete from canonical_resolutions where winning_claim_id in
    (select claim_id from canonical_claims where source_reference like $1)`, [prefix]);
  await del("conflicts", `delete from claim_conflicts where exists (
    select 1 from canonical_claims c where c.source_reference like $1 and c.claim_id = any(claim_ids))`, [prefix]);
  await del("claims", `delete from canonical_claims where source_reference like $1`, [prefix]);
  await del("runs", `delete from rox_ingest_runs where batch_id = $1`, [batchId]);
  if (!args["keep-truth"]) await del("truth", `delete from rox_truth where batch_id = $1`, [batchId]);
  return n;
});

console.log(`reset batch ${batchId}`);
console.table([counts]);
await db.end();
