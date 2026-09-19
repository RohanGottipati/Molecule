// Generates high-volume synthetic time-series data directly in Postgres,
// spread across EVERY real merchant/capability currently in the catalog
// (pulled live from the `merchants`/`capabilities` tables -- run
// generate-catalog first) instead of 4 hardcoded demo capabilities. This is
// what makes "10 million data points" mean something: the volume is spread
// across hundreds of real competing stores and dozens of products, not
// stacked onto one embroidered hoodie over and over.
//
// Run (after generate-catalog):
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

async function main() {
  const numericArg = process.argv.slice(2).map(Number).find((n) => Number.isFinite(n) && n > 0);
  const total = numericArg ?? 10_000_000;

  const fulfillmentRows = Math.floor(total * 0.4);
  const marketRows = Math.floor(total * 0.4);
  const networkRows = total - fulfillmentRows - marketRows;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Export it before running this script.");
  }

  const client = new Client({ connectionString });
  await client.connect();
  await client.query(`set synchronous_commit = off;`);

  const pairsResult = await client.query(`select merchant_id, capability_id from capabilities;`);
  if (pairsResult.rows.length === 0) {
    throw new Error("No capabilities found. Run generate-catalog (and the base migrate/seed) first.");
  }
  const merchantIds: string[] = pairsResult.rows.map((r) => r.merchant_id);
  const capabilityIds: string[] = pairsResult.rows.map((r) => r.capability_id);
  const pairCount = merchantIds.length;

  const distinctMerchants: string[] = Array.from(new Set(merchantIds));

  process.stdout.write(`Spreading volume across ${pairCount} merchant/capability pairs (${distinctMerchants.length} distinct merchants).\n`);

  const start = Date.now();

  try {
    process.stdout.write(`Generating ${fulfillmentRows.toLocaleString()} fulfillment_samples rows...\n`);
    let t0 = Date.now();
    await client.query(
      `
      insert into fulfillment_samples (ts, merchant_id, capability_id, promised_hours, actual_hours, success)
      select
        now() - (random() * interval '90 days') - (gs * interval '1 microsecond'),
        ($1::text[])[idx],
        ($2::text[])[idx],
        promised,
        promised * (0.6 + random() * 0.8),
        random() > 0.06
      from generate_series(1, $3) gs,
           lateral (
             select
               floor(random() * $4 + 1)::int as idx,
               (4 + random() * 68) as promised
           ) i;
    `,
      [merchantIds, capabilityIds, fulfillmentRows, pairCount],
    );
    process.stdout.write(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    process.stdout.write(`Generating ${marketRows.toLocaleString()} market_metrics rows...\n`);
    t0 = Date.now();
    await client.query(
      `
      insert into market_metrics (ts, merchant_id, capability_id, metric, value)
      select
        now() - (random() * interval '90 days') - (gs * interval '1 microsecond'),
        ($1::text[])[idx],
        ($2::text[])[idx],
        (array['capacity', 'inventory', 'price'])[floor(random() * 3 + 1)],
        round((random() * 500)::numeric, 2)
      from generate_series(1, $3) gs,
           lateral (select floor(random() * $4 + 1)::int as idx) i;
    `,
      [merchantIds, capabilityIds, marketRows, pairCount],
    );
    process.stdout.write(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    process.stdout.write(`Generating ${networkRows.toLocaleString()} network_events rows...\n`);
    t0 = Date.now();
    await client.query(
      `
      insert into network_events (ts, trace_id, merchant_id, event_type, source, severity, numeric_value, unit)
      select
        now() - (random() * interval '90 days') - (gs * interval '1 microsecond'),
        gen_random_uuid()::text,
        ($1::text[])[idx],
        (array['claim.ingested', 'claim.resolved', 'claim.conflict', 'reservation.created', 'reservation.released', 'plan.validated'])[floor(random() * 6 + 1)],
        (array['shopify', 'document', 'note', 'manual', 'api'])[floor(random() * 5 + 1)],
        (array['INFO', 'WARN', 'ERROR'])[floor(random() * 3 + 1)],
        round((random() * 200)::numeric, 2),
        'units'
      from generate_series(1, $2) gs,
           lateral (select floor(random() * $3 + 1)::int as idx) i;
    `,
      [distinctMerchants, networkRows, distinctMerchants.length],
    );
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

    const spread = await client.query(`
      select count(distinct capability_id) as distinct_caps, count(distinct merchant_id) as distinct_merchants
      from fulfillment_samples;
    `);
    process.stdout.write(
      `  fulfillment_samples spans ${spread.rows[0].distinct_caps} distinct capabilities across ${spread.rows[0].distinct_merchants} distinct merchants\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
