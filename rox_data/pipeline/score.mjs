#!/usr/bin/env node
// Freeze run inputs in a read-only transaction; write an immutable local report.
// No old scorecard rows are overwritten. --legacy-batch explicitly measures all
// batch artifacts when historical runs lack a recorded selection manifest.
import pg from "pg";
import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { evaluate } from "./evaluate.mjs";
import { BUSINESS_DAY_HOURS, FX_TO_CAD } from "./config.mjs";
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  }),
);
if (
  Object.keys(args).some(
    (key) => !["run", "snapshot", "output", "legacy-batch"].includes(key),
  )
)
  throw new Error(
    "Unknown argument; supported: --run, --snapshot, --output, --legacy-batch",
  );
if (
  typeof args.output !== "string" ||
  (!args.run && !args.snapshot) ||
  (args.run && args.snapshot) ||
  (args.run && typeof args.run !== "string") ||
  (args.snapshot && typeof args.snapshot !== "string")
)
  throw new Error(
    "Required: --run=<id> --output=<new file> [--legacy-batch], or --snapshot=<report> --output=<new file>",
  );
let snapshot;
if (args.snapshot) {
  const saved = JSON.parse(await readFile(String(args.snapshot), "utf8"));
  snapshot = saved.snapshot;
  if (
    saved.snapshotHash !==
    createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
  )
    throw new Error("Snapshot checksum mismatch");
} else {
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });
  try {
    await db.connect();
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const run = (
      await db.query(
        "select run_id,batch_id,status,stage_counts,cost_usd from rox_ingest_runs where run_id=$1",
        [args.run],
      )
    ).rows[0];
    if (!run) throw new Error("Unknown run");
    const selections = (
      await db.query(
        "select payload from molecule_events where event_type='rox.evaluation.population' and payload->>'runId'=$1 order by ts,event_id",
        [args.run],
      )
    ).rows;
    const selectionIds = [
      ...new Set(selections.flatMap((s) => s.payload.artifactIds)),
    ];
    if (!selections.length && !args["legacy-batch"])
      throw new Error(
        "Historical run has no selection manifest. Use --legacy-batch for an explicitly labelled full-batch diagnostic, not attempted-run accuracy.",
      );
    const artifacts = (
      await db.query(
        "select artifact_id,source_path,checksum,content_text,parse_status from raw_artifacts where batch_id=$1 order by artifact_id",
        [run.batch_id],
      )
    ).rows.filter(
      (a) => !selections.length || selectionIds.includes(a.artifact_id),
    );
    if (selections.length && artifacts.length !== selectionIds.length)
      throw new Error(
        "Selection references missing or foreign-batch artifacts",
      );
    const truth = (
      await db.query(
        "select truth_id,source_path,merchant_id,field,true_value,true_unit,is_injection from rox_truth where batch_id=$1 order by truth_id",
        [run.batch_id],
      )
    ).rows;
    const extractions = (
      await db.query(
        "select x.*,a.source_path from rox_extractions x join raw_artifacts a using(artifact_id) where x.run_id=$1 order by extraction_id",
        [args.run],
      )
    ).rows;
    const quarantined = (
      await db.query(
        "select q.field,a.source_path from quarantined_claims q join raw_artifacts a using(artifact_id) where q.run_id=$1 order by a.source_path,q.field",
        [args.run],
      )
    ).rows;
    const attempts = (
      await db.query(
        "select artifact_id,candidates,injection from rox_artifact_attempts where run_id=$1 order by artifact_id",
        [args.run],
      )
    ).rows;
    snapshot = {
      run,
      scope: selections.length
        ? "recorded_selection"
        : "legacy_full_batch_diagnostic",
      capturedAt: new Date().toISOString(),
      artifacts,
      truth,
      extractions,
      quarantined,
      attempts,
      config: { businessDayHours: BUSINESS_DAY_HOURS, fxToCad: FX_TO_CAD },
    };
    await db.query("COMMIT");
  } finally {
    await db.end();
  }
}
const hash = (s) => createHash("sha256").update(s).digest("hex");
const result = evaluate(snapshot);
if (snapshot.scope === "legacy_full_batch_diagnostic")
  result.limitations.unshift(
    "Historical selected/failed artifact identities are unavailable; this full-batch denominator includes potentially unattempted inputs. Do not compare with selected-run scores.",
  );
const sourceFiles = [
  "evaluate.mjs",
  "normalize.mjs",
  "db.mjs",
  "config.mjs",
  "score.mjs",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (f) => [
      f,
      hash(await readFile(new URL(f, import.meta.url))),
    ]),
  ),
);
const report = {
  createdAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  sourceHashes,
  snapshotHash: hash(JSON.stringify(snapshot)),
  snapshot,
  result,
};
await writeFile(String(args.output), JSON.stringify(report, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  JSON.stringify(
    { scope: snapshot.scope, snapshotHash: report.snapshotHash, ...result },
    null,
    2,
  ),
);
