#!/usr/bin/env node
// The Rox pipeline runner. Stages are independent and resumable: each one reads
// what the previous one wrote in Tiger, so a stage can be re-run alone.
//
//   node --env-file=../.env --env-file=../.env.local pipeline/run.mjs --stages=intake
//   node --env-file=../.env --env-file=../.env.local pipeline/run.mjs --stages=extract --limit=50
//   node --env-file=../.env --env-file=../.env.local pipeline/run.mjs            # all stages
//
// Flags: --stages=a,b  --limit=N  --batch=<id>  --dry  --budget=<usd>  --run=<runId>

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { connect, startRun, finishRun, emitEvent, BudgetExceeded } from "./db.mjs";
import { BUDGET_USD, MODELS } from "./config.mjs";
import { intake } from "./intake.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
// Linking runs before normalization: a claim cannot be written without the
// merchant and capability it belongs to.
const ALL_STAGES = ["intake", "extract", "link", "normalize", "resolve", "act"];
// `baseline` replaces `extract` for the control run; it is never part of ALL_STAGES.
const stages = args.stages ? String(args.stages).split(",") : ALL_STAGES;
const limit = args.limit ? Number(args.limit) : null;
const corpus = args.corpus ? String(args.corpus) : join(HERE, "..", "corpus");

const manifest = JSON.parse(await readFile(join(corpus, "manifest.json"), "utf8"));
const batchId = args.batch ? String(args.batch) : manifest.batchId;
const traceId = randomUUID();

const db = await connect();
const runId = args.run
  ? String(args.run)
  : await startRun(db, { batchId, seed: manifest.seed, mode: args.dry ? "dry" : "real", models: MODELS, budget: Number(args.budget ?? BUDGET_USD) });

console.log(`run ${runId}  batch ${batchId}  stages ${stages.join(",")}${limit ? `  limit ${limit}` : ""}`);
await emitEvent(db, { traceId, type: "rox.run.started", payload: { runId, batchId, stages } });

const t0 = Date.now();
try {
  for (const stage of stages) {
    const started = Date.now();
    let counts;
    if (stage === "intake") {
      counts = await intake(db, { runId, root: join(corpus, "inbox"), batchId, traceId, limit });
    } else {
      const mod = await import(`./${stage}.mjs`).catch(() => null);
      if (!mod?.[stage]) { console.log(`  ${stage.padEnd(10)} not implemented yet, skipped`); continue; }
      counts = await mod[stage](db, { runId, batchId, traceId, limit, dry: Boolean(args.dry) });
    }
    console.log(`  ${stage.padEnd(10)} ${((Date.now() - started) / 1000).toFixed(1)}s  ${JSON.stringify(counts)}`);
  }
  await finishRun(db, runId, "completed");
} catch (error) {
  const aborted = error instanceof BudgetExceeded;
  await finishRun(db, runId, aborted ? "aborted" : "failed", error.message);
  await emitEvent(db, { traceId, type: aborted ? "rox.run.aborted" : "rox.run.failed", severity: "ERROR", payload: { runId, error: error.message } });
  console.error(`\n${aborted ? "ABORTED" : "FAILED"}: ${error.message}`);
  if (!aborted && process.env.ROX_DEBUG) console.error(error.stack);
  process.exitCode = 1;
}

const { rows } = await db.query(`select * from rox_run_summary where run_id = $1`, [runId]);
console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.table(rows);
await db.end();
