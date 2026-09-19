// Tops up market_metrics and network_events only (fulfillment_samples
// already has plenty). Run: pnpm --filter @molecule/db topup-seed -- 2000000
import pg from "pg";

const { Client } = pg;

const MERCHANT_IDS = `(array['m-basegoods', 'm-customizeco', 'm-packship', 'm-customizeco2'])`;
const CAPABILITY_IDS = `(array['cap-basegoods-hoodie', 'cap-customizeco-embroidery', 'cap-packship-assembly', 'cap-customizeco2-embroidery'])`;

async function main() {
  const numericArg = process.argv.slice(2).map(Number).find((n) => Number.isFinite(n) && n > 0);
  const total = numericArg ?? 2_000_000;
  const marketRows = Math.floor(total * 0.6);
  const networkRows = total - marketRows;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Export it before running this script.");
  }

  const client = new Client({ connectionString });
  await client.connect();
  await client.query(`set synchronous_commit = off;`);
  await client.query(`set statement_timeout = '120s';`);

  const start = Date.now();

  try {
    process.stdout.write(`Generating ${marketRows.toLocaleString()} market_metrics rows...\n`);
    let t0 = Date.now();
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

    process.stdout.write(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s total.\n`);
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
