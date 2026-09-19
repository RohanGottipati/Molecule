#!/usr/bin/env node
// Showcase queries over the bulk commerce data (millions of rows). Prints timings; read-only.
//   node --env-file=.env --env-file=.env.local scripts/bulk/demo-queries.mjs [--only=rfm]
import { connectDb, parseArgs } from "../lib/molecule-env.mjs";
const args = parseArgs();
const db = await connectDb();
await db.query("set statement_timeout = '90s'");

const QUERIES = {
  revenue_by_year: [`Revenue and refunds by year (continuous aggregate: pre-computed daily rollup over ~5M lines)`,
    `select extract(year from day)::int as year, round(sum(revenue)) as revenue, round(sum(refunds)) as refunds, sum(units) as units
     from bulk_sales_daily group by 1 order by 1 desc limit 8`],
  top_products: [`Top 10 products by lifetime revenue (monthly product aggregate joined to the product catalog)`,
    `select p.sku, p.title, round(sum(m.revenue)) as revenue, sum(m.units) as units
     from bulk_product_monthly m join bulk_products p on p.sku = m.sku group by 1, 2 order by revenue desc limit 10`],
  seasonality: [`Which month of the year sells the most (window over the daily aggregate)`,
    `select extract(month from day)::int as month, round(sum(revenue)) as revenue,
            round(100 * sum(revenue) / sum(sum(revenue)) over (), 1) as pct_of_total
     from bulk_sales_daily group by 1 order by 1`],
  rfm: [`RFM customer segments on the last 2 years of orders (recency / frequency / monetary, quintiles via NTILE)`,
    `with c as (
       select customer_id, max(invoice_ts) as last_buy, count(distinct invoice) as orders, sum(line_total) as spend
       from bulk_order_lines where customer_id is not null and not is_cancel and invoice_ts > now() - interval '2 years' group by 1),
     s as (select *, ntile(5) over (order by last_buy) r, ntile(5) over (order by orders) f, ntile(5) over (order by spend) m from c)
     select case when r >= 4 and f >= 4 then 'champions' when r >= 4 then 'recent' when f >= 4 then 'loyal but lapsing' when r <= 2 and m >= 4 then 'big spenders at risk' else 'other' end as segment,
            count(*) as customers, round(avg(spend)) as avg_spend
     from s group by 1 order by customers desc`],
  basket_pairs: [`Products most often bought together (market-basket self-join, one year of real orders)`,
    `select a.sku as sku_a, b.sku as sku_b, count(*) as together
     from bulk_order_lines a join bulk_order_lines b on a.invoice = b.invoice and a.pass = b.pass and a.sku < b.sku
     where a.pass = 0 and a.invoice_ts >= '2011-01-01' and a.invoice_ts < '2011-04-01' and b.invoice_ts >= '2011-01-01' and b.invoice_ts < '2011-04-01' and not a.is_cancel
     group by 1, 2 order by together desc limit 8`],
  cohorts: [`Customer cohort retention: share of each first-purchase cohort still ordering N months later`,
    `with f as (select customer_id, date_trunc('month', min(invoice_ts)) as cohort from bulk_order_lines where pass = 0 and customer_id is not null group by 1),
     a as (select distinct customer_id, date_trunc('month', invoice_ts) as m from bulk_order_lines where pass = 0 and customer_id is not null and not is_cancel)
     select to_char(f.cohort, 'YYYY-MM') as cohort, count(distinct f.customer_id) as customers,
       round(100.0 * count(distinct a.customer_id) filter (where a.m = f.cohort + interval '1 month') / count(distinct f.customer_id)) as m1_pct,
       round(100.0 * count(distinct a.customer_id) filter (where a.m = f.cohort + interval '6 months') / count(distinct f.customer_id)) as m6_pct
     from f join a using (customer_id) group by f.cohort order by f.cohort limit 8`],
  food_nutrition: [`Open Food Facts catalog: average nutrition by Nutri-Score (real product data)`,
    `select nutriscore, count(*) as products, round(avg(kcal_100g)) as kcal, round(avg(sugars_100g), 1) as sugars, round(avg(salt_100g), 2) as salt
     from bulk_products where source = 'open_food_facts' and nutriscore in ('a','b','c','d','e') group by 1 order by 1`],
};

for (const [name, [title, sql]] of Object.entries(QUERIES)) {
  if (args.only && args.only !== name) continue;
  const t0 = Date.now();
  try {
    const r = await db.query(sql);
    console.log(`\n## ${name} - ${title}\n   ${r.rowCount} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.table(r.rows.slice(0, 8));
  } catch (e) { console.log(`\n## ${name}: FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s - ${e.message}`); }
}
await db.end();
