import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transaction, type DbClient } from "./client.js";
import { resolveAllMerchants } from "./resolution.js";

export function sqlDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "sql", "001_core.sql"))) {
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("Cannot locate Molecule SQL migrations");
    directory = parent;
  }
  return join(directory, "sql");
}

export async function migrate(): Promise<void> {
  const directory = sqlDirectory();
  const files = (await readdir(directory))
    .filter((file) => /^\d+_.+\.sql$/.test(file) && !file.includes("seed"))
    .sort();
  for (const file of files) {
    const sql = await readFile(join(directory, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    await transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(73481201)");
      await client.query(`create table if not exists molecule_migrations (
        filename text primary key, checksum text not null, applied_at timestamptz not null default now())`);
      const existing = await client.query<{ checksum: string }>(
        "select checksum from molecule_migrations where filename = $1",
        [file],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${file}`);
        return;
      }
      // 010 predates the optional-Timescale policy used by 002/003. Guard its
      // extension-only statements without changing an already-applied checksum.
      // Plain PostgreSQL retains all tables and indexes, without compression.
      const executableSql =
        file === "010_bulk_commerce.sql"
          ? sql.replace(
              /select create_hypertable\([^;]+;|alter table bulk_order_lines set \([\s\S]*?\);|select add_compression_policy\([^;]+;/g,
              (statement) => `do $compat$ begin
              if exists(select 1 from pg_extension where extname='timescaledb') then
                execute $statement$${statement}$statement$;
              end if;
            end $compat$;`,
            )
          : sql;
      await client.query(executableSql);
      await client.query(
        "insert into molecule_migrations(filename,checksum) values ($1,$2)",
        [file, checksum],
      );
    });
  }
}

export async function seedDemo(client?: DbClient): Promise<void> {
  if (process.env.DEMO_MODE !== "true")
    throw new Error("Demo seed requires DEMO_MODE=true");
  const sql = await readFile(join(sqlDirectory(), "004_seed.sql"), "utf8");
  const seed = async (connection: DbClient) => {
    await connection.query("select pg_advisory_xact_lock(73481202)");
    await connection.query(sql);
    // The seed inserts contradictory claims on purpose (100/day, 50/day and a
    // fresh 20/day outage note). Resolve them here so the demo database is left
    // in an adjudicated state: without this, losing claims stay 'active' and
    // nothing has written `canonical_resolutions`.
    await resolveAllMerchants("seed-demo", connection);
  };
  if (client) await seed(client);
  else await transaction(seed);
}

export async function resetDemoData(): Promise<void> {
  if (process.env.DEMO_MODE !== "true")
    throw new Error("Demo reset requires DEMO_MODE=true");
  await transaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(73481202)");
    await client.query(`update capabilities c set capability_json = b.capability_json, updated_at = now()
      from demo_capability_baselines b where b.capability_id = c.capability_id`);
    await client.query(
      `update merchants set status = 'online' where demo_tag = 'MOLECULE_DEMO'`,
    );
    await client.query(`update reservations set status = 'released'
      where status = 'active' and merchant_id in (select merchant_id from merchants where demo_tag = 'MOLECULE_DEMO')`);
    await client.query(`delete from canonical_resolutions where merchant_id in
      (select merchant_id from merchants where demo_tag = 'MOLECULE_DEMO')`);
    await client.query(`delete from claim_conflicts where merchant_id in
      (select merchant_id from merchants where demo_tag = 'MOLECULE_DEMO')`);
    await client.query(`delete from canonical_claims where source_reference like 'demo:chaos:%'
      and merchant_id in (select merchant_id from merchants where demo_tag = 'MOLECULE_DEMO')`);
    await client.query(`update canonical_claims set resolution_status = 'active'
      where resolution_status != 'quarantined' and merchant_id in
      (select merchant_id from merchants where demo_tag = 'MOLECULE_DEMO')`);
    await client.query(
      "update demo_chaos_actions set reverted_at = now() where reverted_at is null",
    );
    await seedDemo(client);
    await client.query(`insert into molecule_events(event_id,trace_id,event_type,severity,source,ts,payload)
      values (gen_random_uuid()::text,'demo-reset','reality.demo.reset','INFO','rox',now(),
      '{"scope":"MOLECULE_DEMO"}')`);
  });
}
