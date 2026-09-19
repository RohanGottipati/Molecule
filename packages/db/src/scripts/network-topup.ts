import pg from "pg";
const { Client } = pg;
const MERCHANT_IDS = `(array['m-basegoods', 'm-customizeco', 'm-packship', 'm-customizeco2'])`;

async function main() {
  const rows = Number(process.argv[2]) || 300000;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`set synchronous_commit = off;`);
  await client.query(`set statement_timeout = '180s';`);
  const t0 = Date.now();
  process.stdout.write(`Generating ${rows.toLocaleString()} network_events rows...\n`);
  await client.query(`
    insert into network_events (ts, trace_id, merchant_id, event_type, source, severity, numeric_value, unit)
    select
      now() - (random() * interval '90 days') - (gs * interval '1 microsecond'),
      gen_random_uuid()::text,
      ${MERCHANT_IDS}[floor(random() * 4 + 1)::int],
      (array['claim.ingested', 'claim.resolved', 'claim.conflict', 'reservation.created', 'reservation.released', 'plan.validated'])[floor(random() * 6 + 1)],
      (array['shopify', 'document', 'note', 'manual', 'api'])[floor(random() * 5 + 1)],
      (array['INFO', 'WARN', 'ERROR'])[floor(random() * 3 + 1)],
      round((random() * 200)::numeric, 2),
      'units'
    from generate_series(1, ${rows}) gs;
  `);
  process.stdout.write(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  const r = await client.query(`select count(*) from network_events;`);
  process.stdout.write(`network_events total: ${Number(r.rows[0].count).toLocaleString()}\n`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
