import pg from "pg";
const { Client } = pg;
const BATCH_SIZE = 200_000;
async function insertFulfillmentBatch(client: pg.Client, merchantIds: string[], capabilityIds: string[], rows: number, pairCount: number, offset: number) {
  await client.query(`insert into fulfillment_samples (ts, merchant_id, capability_id, promised_hours, actual_hours, success) select now() - (random() * interval '90 days') - ((gs + $5) * interval '1 microsecond'), ($1::text[])[idx], ($2::text[])[idx], promised, promised * (0.6 + random() * 0.8), random() > 0.06 from generate_series(1, $3) gs, lateral (select gs as _forced, floor(random() * $4 + 1)::int as idx, (4 + random() * 68) as promised) i on conflict (ts, merchant_id, capability_id) do nothing;`, [merchantIds, capabilityIds, rows, pairCount, offset]);
}
async function insertMarketBatch(client: pg.Client, merchantIds: string[], capabilityIds: string[], rows: number, pairCount: number, offset: number) {
  await client.query(`insert into market_metrics (ts, merchant_id, capability_id, metric, value) select now() - (random() * interval '90 days') - ((gs + $5) * interval '1 microsecond'), ($1::text[])[idx], ($2::text[])[idx], (array['capacity', 'inventory', 'price'])[floor(random() * 3 + 1)], round((random() * 500)::numeric, 2) from generate_series(1, $3) gs, lateral (select gs as _forced, floor(random() * $4 + 1)::int as idx) i;`, [merchantIds, capabilityIds, rows, pairCount, offset]);
}
async function insertNetworkBatch(client: pg.Client, distinctMerchants: string[], rows: number, offset: number) {
  await client.query(`insert into network_events (ts, trace_id, merchant_id, event_type, source, severity, numeric_value, unit) select now() - (random() * interval '90 days') - ((gs + $4) * interval '1 microsecond'), gen_random_uuid()::text, ($1::text[])[idx], (array['claim.ingested', 'claim.resolved', 'claim.conflict', 'reservation.created', 'reservation.released', 'plan.validated'])[floor(random() * 6 + 1)], (array['shopify', 'document', 'note', 'manual', 'api'])[floor(random() * 5 + 1)], (array['INFO', 'WARN', 'ERROR'])[floor(random() * 3 + 1)], round((random() * 200)::numeric, 2), 'units' from generate_series(1, $2) gs, lateral (select gs as _forced, floor(random() * $3 + 1)::int as idx) i;`, [distinctMerchants, rows, distinctMerchants.length, offset]);
}
async function runBatched(label: string, totalRows: number, runBatch: (rows: number, offset: number) => Promise<void>) {
  process.stdout.write(`Generating ${totalRows.toLocaleString()} ${label} rows in batches of ${BATCH_SIZE.toLocaleString()}...\n`);
  let done = 0;
  const start = Date.now();
  while (done < totalRows) {
    const thisBatch = Math.min(BATCH_SIZE, totalRows - done);
    const t0 = Date.now();
    await runBatch(thisBatch, done);
    done += thisBatch;
    const batchSec = ((Date.now() - t0) / 1000).toFixed(1);
    const totalSec = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`  ${label}: ${done.toLocaleString()}/${totalRows.toLocaleString()} (batch ${batchSec}s, elapsed ${totalSec}s)\n`);
  }
}
async function main() {
  const numericArg = process.argv.slice(2).map(Number).find((n) => Number.isFinite(n) && n > 0);
  const total = numericArg ?? 3_000_000;
  const fulfillmentRows = Math.floor(total * 0.4);
  const marketRows = Math.floor(total * 0.4);
  const networkRows = total - fulfillmentRows - marketRows;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) { throw new Error("DATABASE_URL is not set. Export it before running this script."); }
  const client = new Client({ connectionString });
  await client.connect();
  await client.query(`set synchronous_commit = off;`);
  const pairsResult = await client.query(`select merchant_id, capability_id from capabilities;`);
  if (pairsResult.rows.length === 0) { throw new Error("No capabilities found. Run generate-catalog (and the base migrate/seed) first."); }
  const merchantIds = pairsResult.rows.map((r) => r.merchant_id);
  const capabilityIds = pairsResult.rows.map((r) => r.capability_id);
  const pairCount = merchantIds.length;
  const distinctMerchants = Array.from(new Set(merchantIds));
  process.stdout.write(`Spreading volume across ${pairCount} merchant/capability pairs (${distinctMerchants.length} distinct merchants).\n`);
  const start = Date.now();
  try {
    await runBatched("fulfillment_samples", fulfillmentRows, (rows, offset) => insertFulfillmentBatch(client, merchantIds, capabilityIds, rows, pairCount, offset));
    await runBatched("market_metrics", marketRows, (rows, offset) => insertMarketBatch(client, merchantIds, capabilityIds, rows, pairCount, offset));
    await runBatched("network_events", networkRows, (rows, offset) => insertNetworkBatch(client, distinctMerchants, rows, offset));
    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`Done. Inserted ${total.toLocaleString()} rows across 3 hypertables in ${elapsedSec}s.\n`);
    const counts = await client.query(`select 'fulfillment_samples' as table, count(*) from fulfillment_samples union all select 'market_metrics', count(*) from market_metrics union all select 'network_events', count(*) from network_events;`);
    for (const row of counts.rows) { process.stdout.write(`  ${row.table}: ${Number(row.count).toLocaleString()} total rows\n`); }
    const spread = await client.query(`select count(distinct capability_id) as distinct_caps, count(distinct merchant_id) as distinct_merchants from fulfillment_samples;`);
    process.stdout.write(`  fulfillment_samples spans ${spread.rows[0].distinct_caps} distinct capabilities across ${spread.rows[0].distinct_merchants} distinct merchants\n`);
    const marketSpread = await client.query(`select count(distinct capability_id) as distinct_caps, count(distinct merchant_id) as distinct_merchants from market_metrics;`);
    process.stdout.write(`  market_metrics spans ${marketSpread.rows[0].distinct_caps} distinct capabilities across ${marketSpread.rows[0].distinct_merchants} distinct merchants\n`);
  } finally {
    await client.end();
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
