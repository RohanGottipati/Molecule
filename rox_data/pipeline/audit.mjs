#!/usr/bin/env node
// Read-only, aggregate-only inventory. Never emits credentials or document text.
import pg from "pg";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const output = process.argv.find((a) => a.startsWith("--output="))?.slice(9);
if (!output) throw new Error("Required: --output=<new JSON file>");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  statement_timeout: 45000,
  application_name: "molecule-readonly-audit",
});
const report = { capturedAt: new Date().toISOString(), checks: {} };
try {
  await client.connect();
  // Read the original setting BEFORE imposing a read-only audit transaction.
  report.server = (
    await client.query(
      "select current_setting('default_transaction_read_only') as default_read_only, pg_is_in_recovery() as in_recovery, pg_database_size(current_database())::text as bytes",
    )
  ).rows[0];
  const queries = {
    extensions: "select extname,extversion from pg_extension order by 1",
    migrations:
      "select filename,checksum from molecule_migrations order by filename",
    sales:
      "select pass,count(*) as rows from bulk_order_lines group by pass order by pass",
    products:
      "select source,price_is_synthetic,count(*) as rows from bulk_products group by 1,2 order by 1,2",
    merchants:
      "select coalesce(demo_tag,'UNLABELLED') as provenance,count(*) as rows from merchants group by 1",
    artifacts:
      "select batch_id,parse_status,count(*) as rows from raw_artifacts group by 1,2 order by 1,2",
    claims:
      "select source_kind,resolution_status,count(*) as rows from canonical_claims group by 1,2 order by 1,2",
    attempts:
      "select run_id,count(*) as completed_artifacts,sum(candidates) as candidates,count(*) filter(where candidates=0) as empty from rox_artifact_attempts group by 1 order by 1",
    quantities:
      "select method,count(*) as rows from bulk_product_quantities group by 1",
    duplicate_artifacts:
      "select count(*) as groups,coalesce(sum(n-1),0) as excess_rows from (select count(*) n from raw_artifacts group by checksum,source_reference having count(*)>1) d",
    duplicate_product_names:
      "select count(*) as groups,coalesce(sum(n-1),0) as excess_rows from (select count(*) n from bulk_products group by source,lower(trim(title)) having count(*)>1) d",
    duplicate_claim_observations:
      "select count(*) as groups,coalesce(sum(n-1),0) as excess_rows from (select count(*) n from canonical_claims group by merchant_id,field,source_reference,source_checksum,observed_at,normalized_value,normalized_unit having count(*)>1) d",
    activity:
      "select state,count(*) as sessions,count(*) filter(where xact_start < now()-interval '5 minutes') as old_transactions from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() group by state",
    locks:
      "select count(*) filter(where not granted) as waiting_locks from pg_locks",
    fulfillment: "select count(*) as rows from fulfillment_samples",
  };
  for (const [name, sql] of Object.entries(queries)) {
    const start = Date.now();
    try {
      await client.query("BEGIN READ ONLY");
      report.checks[name] = {
        rows: (await client.query(sql)).rows,
        ms: Date.now() - start,
      };
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      report.checks[name] = {
        errorCode: e.code ?? e.name,
        ms: Date.now() - start,
      };
    }
    console.log(name + ": " + (report.checks[name].errorCode ?? "ok"));
  }
  // Bound memory by UTC calendar month and replay pass. Duplicate signatures
  // include invoice_ts, so identical rows cannot cross these partitions.
  const partitions = (
    await client.query(
      "select pass,date_trunc('month',invoice_ts at time zone 'UTC') at time zone 'UTC' as start from bulk_order_lines group by 1,2 order by 1,2",
    )
  ).rows;
  const duplicateSales = [];
  for (const part of partitions) {
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL work_mem='4MB'");
      await client.query("SET LOCAL enable_hashagg=off");
      await client.query("SET LOCAL max_parallel_workers_per_gather=0");
      const { rows } = await client.query(
        `select count(*) as groups,coalesce(sum(n-1),0) as excess_rows from (
    select count(*) n from bulk_order_lines where pass=$1 and invoice_ts >= $2::timestamptz and invoice_ts < $2::timestamptz+interval '1 month'
    group by invoice_ts,invoice,sku,quantity,unit_price,customer_id,country having count(*)>1) d`,
        [part.pass, part.start],
      );
      duplicateSales.push({ ...part, ...rows[0] });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      duplicateSales.push({ ...part, errorCode: e.code ?? e.name });
    }
  }
  report.checks.duplicate_sales_within_pass = {
    partitions: duplicateSales,
    complete: duplicateSales.every((p) => !p.errorCode),
    groups: duplicateSales.reduce((n, p) => n + Number(p.groups ?? 0), 0),
    excess_rows: duplicateSales.reduce(
      (n, p) => n + Number(p.excess_rows ?? 0),
      0,
    ),
  };
  console.log(
    "duplicate_sales_within_pass: " +
      (report.checks.duplicate_sales_within_pass.complete
        ? "ok"
        : "incomplete"),
  );
  const applied = new Map(
    (report.checks.migrations.rows ?? []).map((r) => [r.filename, r.checksum]),
  );
  report.localMigrations = [];
  for (const file of (await readdir(new URL("../../sql/", import.meta.url)))
    .filter((f) => /^\d+_.+\.sql$/.test(f) && !f.includes("seed"))
    .sort()) {
    const hash = createHash("sha256")
      .update(await readFile(new URL("../../sql/" + file, import.meta.url)))
      .digest("hex");
    report.localMigrations.push({
      file,
      status: !applied.has(file)
        ? "not_recorded"
        : applied.get(file) === hash
          ? "matches"
          : "checksum_mismatch",
    });
  }
  report.caveats = [
    "Duplicate signatures are review candidates, not proof of accidental duplication.",
    "Sales comparison includes pass, so intentional replay across passes is excluded.",
    "Unlabelled provenance is unknown, not real.",
    "Checks use separate read-only transactions; concurrent writes may change counts.",
  ];
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log("Saved " + output);
} finally {
  await client.end();
}
