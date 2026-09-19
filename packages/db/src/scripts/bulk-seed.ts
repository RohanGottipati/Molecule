// Generates high-volume synthetic time-series data directly in Postgres
// (via generate_series + array-indexed random pick of merchant/capability,
// no per-row sort), so Tiger Data's hypertables have real scale to demo
// against. NOT part of the normal migrate/seed pipeline -- run manually:
//
//   pnpm --filter @molecule/db bulk-seed
//
// Default is 10,000,000 rows split across the three hypertables. Pass a
// number to change the total, e.g.:
//
//   pnpm --filter @molecule/db bulk-seed -- 5000000
//
// Safe to run more than once -- it only *adds* rows, it never deletes.
import pg from "pg";

const { Client } = pg;

// Array-indexed instead of a LATERAL "order by random() limit 1" -- the
// latter forces Postgres to sort per row, which is brutally slow at
// millions of rows. Indexing an array by floor(random()*4+1) is just
// arithmetic, no sort, and is dramatically faster.
const MERCHANT_IDS = `(array['m-basegoods', 'm-customizeco', 'm-packship', 'm-customizeco2'])`;
const CAPABILITY_IDS = `(array['cap-basegoods-hoodie', 'cap-customizeco-embroidery', 'cap-packship-assembly', 'cap-customizeco2-embroidery'])`;
const PROMISED_HOURS = `(array[12.0, 24.0, 12.0, 48.0])`;

async function main() {
  const numericArg = process.argv.slice(2).map(Number).find((n) => Number.isFinite(n) && n > 0);
  const total = numericArg ?? 10_000_000;

  // Split roughly 40% fulfillment_samples / 40% market_metrics / 20% network_events.
  const fulfillmentRows = Math.floor(total * 0.4);
  const marketRows = Math.floor(total * 0.4);
  const networkRows = total - fulfillmentRows - marketRows;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Export it before running this script.");
  }

  const client = new Client({ connectionString });
  await client.connect();
  // Bulk generation is throwaway demo data -- skip WAL fsync overhead per commit.
  await client.query(`set synchronous_commit = off;`);

  const start = Date.now();

  try {
    process.stdout.write(`Generating ${fulfillmentRows.toLocaleString()} fulfillment_samples rows...\n`);
    let t0 = Date.now();
    await client.query(`
      insert into fulfillment_samples (ts, merchant_id, capability_id, promised_hours, actual_hours, success)
      select
        now() - (random() * interval '90 days') - (gs * interval '1 microsecond'),
        ${MERCHANT_IDS}[idx],
        ${CAPABILITY_IDS}[idx],
        ${PROMISED_HOURS}[idx],
        ${PROMISED_HOURS}[idx] * (0.6 + random() * 0.8),
        random() > 0.06
      from generate_series(1, ${fulfillmentRows}) gs,
           lateral (select floor(random() * 4 + 1)::int as idx) i;
    `);
    process.stdout.write(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    process.stdout.write(`Generating ${marketRows.toLocaleString()} market_metrics rows...\n`);
    t0 = Date.now();
    await client.query(`
      insert into market_metrics (ts, merchant_id, capability_id, metric, value)
      select
        now() - (random() * interval '90 days') - (gs * interval '1 microsecond'),
        ${MERCHANT_IDS}[idx],
        ${CAPABILITY_IDS}[idx],
        (array['capacity', 'inventory', 'price'])[floor(random() * 3 + 1)],
        round((random() * 500)::numeric, 2)
      from generate_series(1, ${marketRows}) gs,
           lateral (select floor(random() * 4 + 1)::int as idx) i;
    `);
    process.stdout.write(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    process.stdout.write(`Generating ${networkRows.toLocaleString()} network_events rows...\n`);
    t0 = Date.now();
    await client.query(`
      insert into network_events (ts, trace_id, merchant_id, event_type, source, severity, numeric_value, unit)
      select
        now() - (random() * interval '90 days') - (gs * interval '1 microsecond'),
        gen_random_uuid()::text,
        ${MERCHANT_IDS}[idx],
        (array['claim.ingested', 'claim.resolved', 'claim.conflict', 'reservation.created', 'reservation.released', 'plan.validated'])[floor(random() * 6 + 1)],
        (array['shopify', 'document', 'note', 'manual', 'api'])[floor(random() * 5 + 1)],
        (array['INFO', 'WARN', 'ERROR'])[floor(random() * 3 + 1)],
        round((random() * 200)::numeric, 2),
        'units'
      from generate_series(1, ${networkRows}) gs,
           lateral (select floor(random() * 4 + 1)::int as idx) i;
    `);
    process.stdout.write(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`Done. Inserted ${total.toLocaleString()} rows across 3 hypertables in ${elapsedSec}s.\n`);

    const counts = await client.query(`
      select 'fulfillment_samples' as table, count(*) from fulfillment_samples
      union all select 'market_metrics', count(*) from market_metrics
      union all select 'network_events', count(*) from network_events;
    `);
    for (const row of counts.rows) {
      process.stdout.write(`  ${row.table}: ${Number(row.count).toLocaleString()} total rows\n`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
