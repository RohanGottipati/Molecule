#!/usr/bin/env node
// Bulk-load real open datasets into Tiger and grow them to millions of rows. Resumable and idempotent.
//
//   node --env-file=.env --env-file=.env.local scripts/bulk/bulk-load.mjs --uci=~/data/uci_lines.csv --off=~/data/off_products.csv
//   node --env-file=.env --env-file=.env.local scripts/bulk/bulk-load.mjs --replay --target-rows=5000000 [--max-gb=8]
//   node --env-file=.env --env-file=.env.local scripts/bulk/bulk-load.mjs --stats
//
// Steps (each is skipped when already completed, see bulk_load_runs):
//   --uci=<csv>    load pass 0 = real UCI Online Retail II lines, derive UCI products
//   --off=<csv>    load real Open Food Facts products (synthetic prices, flagged)
//   --replay       add re-timed derived passes (pass 1..8) until --target-rows or the size guard is hit
//   --aggregates   create + refresh continuous aggregates (also done automatically after --uci/--replay)
//   --compress     compress chunks older than 60 days (also runs after every replay pass)
//   --stats        print counts and database size
//   --max-seconds  time budget per invocation (default 150); every step resumes where it stopped
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { connectDb, parseArgs, maskUrl } from "../lib/molecule-env.mjs";

const args = parseArgs();
const expand = (p) => (p ? String(p).replace(/^~/, homedir()) : p);
const num = (v, d) => (v === undefined || v === true ? d : Number(v));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Streaming CSV parser (RFC 4180: quotes, escaped quotes, embedded newlines). Yields string[] rows. */
async function* csvRows(file) {
  let field = "", row = [], inQ = false, prevQuote = false;
  for await (const chunk of createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 })) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (inQ) {
        if (prevQuote) { prevQuote = false; if (c === '"') { field += '"'; continue; } inQ = false; }
        else if (c === '"') { prevQuote = true; continue; }
        else { field += c; continue; }
      }
      if (c === '"' && field === "") { inQ = true; }
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { if (field.endsWith("\r")) field = field.slice(0, -1); row.push(field); yield row; row = []; field = ""; }
      else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); yield row; }
}

// Tool calls that run this script are time-limited, so every step is resumable: --max-seconds stops cleanly, re-run to continue.
const deadline = Date.now() + num(args["max-seconds"], 150) * 1000;
const outOfTime = () => Date.now() > deadline;

const db = await connectDb();
const q = (sql, p) => db.query(sql, p);
log("connected", maskUrl(process.env.DATABASE_URL).replace(/\?.*/, ""));

async function completed(kind, pass = null) {
  return (await q("select 1 from bulk_load_runs where kind=$1 and coalesce(pass,-1)=coalesce($2,-1) and status='completed'", [kind, pass])).rowCount > 0;
}
async function startRun(kind, pass = null, detail = {}) {
  return (await q("insert into bulk_load_runs(kind,pass,detail) values($1,$2,$3) returning id", [kind, pass, detail])).rows[0].id;
}
const finishRun = (id, rows, status = "completed") => q("update bulk_load_runs set rows_loaded=$2, status=$3, finished_at=now() where id=$1", [id, rows, status]);
const dbSizeGb = async () => Number((await q("select pg_database_size(current_database())::float8 / 1073741824 as gb")).rows[0].gb);

// ---------- pass 0: UCI ----------
async function loadUci(file) {
  if (await completed("uci_pass0", 0)) { log("uci pass 0 already loaded (skip)"); return true; }
  const prev = (await q("select id from bulk_load_runs where kind='uci_pass0' and status in ('running','failed') order by id desc limit 1")).rows[0];
  let run, resumeFrom = -1;
  if (prev) {
    run = prev.id; await q("update bulk_load_runs set status='running' where id=$1", [run]);
    resumeFrom = Number((await q("select coalesce(max(src_row), -1) m from bulk_order_lines where pass=0")).rows[0].m);
    log("resuming uci pass 0 after src_row", resumeFrom);
  } else run = await startRun("uci_pass0", 0, { file: file.split("/").pop() });
  const cols = { ts: [], row: [], inv: [], sku: [], desc: [], qty: [], price: [], cust: [], country: [], cancel: [] };
  let total = 0, header = true;
  const flush = async () => {
    if (!cols.ts.length) return;
    await q(
      `insert into bulk_order_lines (invoice_ts,pass,src_row,invoice,sku,description,quantity,unit_price,line_total,customer_id,country,is_cancel,currency)
       select ts, 0, r, inv, sku, d, qty, p, qty*p, cu, co, ca, 'GBP'
       from unnest($1::timestamptz[],$2::int[],$3::text[],$4::text[],$5::text[],$6::int[],$7::numeric[],$8::text[],$9::text[],$10::bool[]) as t(ts,r,inv,sku,d,qty,p,cu,co,ca)
       on conflict do nothing`,
      [cols.ts, cols.row, cols.inv, cols.sku, cols.desc, cols.qty, cols.price, cols.cust, cols.country, cols.cancel]);
    total += cols.ts.length;
    for (const k of Object.keys(cols)) cols[k] = [];
    if (total % 100000 < 10000) log("uci lines loaded", total);
  };
  try {
    for await (const r of csvRows(file)) {
      if (header) { header = false; continue; }
      const [srcRow, invoice, code, desc, qty, ts, price, cust, country] = r;
      if (!invoice || Number(srcRow) <= resumeFrom) continue;
      if (outOfTime()) { await flush(); await q("update bulk_load_runs set rows_loaded=(select count(*) from bulk_order_lines where pass=0) where id=$1", [run]); log("time budget reached, loaded so far", total, "- re-run the same command to resume"); return false; }
      cols.ts.push(`${ts}+00`); cols.row.push(Number(srcRow)); cols.inv.push(invoice); cols.sku.push(code); cols.desc.push(desc);
      cols.qty.push(Number(qty)); cols.price.push(price); cols.cust.push(cust || null); cols.country.push(country); cols.cancel.push(invoice.startsWith("C"));
      if (cols.ts.length >= 10000) await flush();
    }
    await flush();
    await q(`insert into bulk_products (sku, source, title, category, price, currency, price_is_synthetic)
      select sku, 'uci_online_retail_ii', coalesce(mode() within group (order by description) filter (where description <> ''), sku),
        case
          when upper(mode() within group (order by description)) ~ 'CANDLE|LIGHT|LANTERN|LAMP' then 'Lighting & candles'
          when upper(mode() within group (order by description)) ~ 'CHRISTMAS|XMAS|EASTER|HALLOWEEN' then 'Seasonal'
          when upper(mode() within group (order by description)) ~ 'CARD|WRAP|PAPER|NOTEBOOK|PEN|STICKER' then 'Stationery & wrap'
          when upper(mode() within group (order by description)) ~ 'MUG|CUP|TEA|PLATE|BOWL|JAR|KITCHEN|CAKE' then 'Kitchen & dining'
          when upper(mode() within group (order by description)) ~ 'BAG|BOX|CASE|BASKET|TIN' then 'Storage & bags'
          else 'Home & gifts' end,
        percentile_cont(0.5) within group (order by unit_price), 'GBP', false
      from bulk_order_lines where pass = 0 group by sku
      on conflict (sku) do nothing`);
    const all = Number((await q("select count(*) n from bulk_order_lines where pass=0")).rows[0].n);
    await finishRun(run, all);
    log("uci pass 0 complete", all, "lines");
    return true;
  } catch (e) { await finishRun(run, total, "failed"); throw e; }
}

// ---------- Open Food Facts products ----------
async function loadOff(file) {
  if (await completed("off_products")) { log("off products already loaded (skip)"); return true; }
  await q("delete from bulk_load_runs where kind='off_products' and status<>'completed'");
  const run = await startRun("off_products", null, { file: file.split("/").pop() });
  let header = null, total = 0, batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const c = (i) => batch.map((r) => r[i]);
    await q(
      `insert into bulk_products (sku,source,title,brand,category,subcategory,quantity_label,countries,nutriscore,nova_group,kcal_100g,sugars_100g,fat_100g,protein_100g,salt_100g,allergens,ingredients,scans,price,currency,price_is_synthetic)
       select code,'open_food_facts',name,brand,cat,sub,qty,countries,nullif(ns,''),nullif(nova,'')::numeric,nullif(kcal,'')::numeric,nullif(sug,'')::numeric,nullif(fat,'')::numeric,nullif(prot,'')::numeric,nullif(salt,'')::numeric,allergens,ingr,nullif(scans,'')::numeric,price::numeric,'CAD',true
       from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[],$11::text[],$12::text[],$13::text[],$14::text[],$15::text[],$16::text[],$17::text[],$18::text[]) as t(code,name,brand,cat,sub,qty,countries,ns,nova,kcal,sug,fat,prot,salt,allergens,ingr,scans,price)
       on conflict (sku) do nothing`,
      Array.from({ length: 18 }, (_, i) => c(i)));
    total += batch.length; batch = [];
  };
  // OFF csv columns (prep_off.py): code,product_name,brands,quantity,pnns_groups_1,pnns_groups_2,main_category_en,countries_en,nutriscore_grade,nova_group,energy-kcal_100g,sugars_100g,fat_100g,proteins_100g,salt_100g,allergens_en,ingredients_text,unique_scans_n,price_cad
  try {
    for await (const r of csvRows(file)) {
      if (!header) { header = r; continue; }
      if (r.length < 19) continue;
      const [code, name, brand, qty, g1, g2, main, countries, ns, nova, kcal, sug, fat, prot, salt, allergens, ingr, scans, price] = r;
      batch.push([code, name, brand, g1 || main, g2 || main, qty, countries, ns, nova, kcal, sug, fat, prot, salt, allergens, ingr, scans, price]);
      if (batch.length >= 5000) { await flush(); if (total % 25000 === 0) log("off products loaded", total); }
    }
    await flush();
    await finishRun(run, total);
    log("off products complete", total);
    return true;
  } catch (e) { await finishRun(run, total, "failed"); throw e; }
}

// ---------- replay passes ----------
// Each pass gets its own volume scale and keep-rate (and a pass-specific hash) so years do not look like copies of each other.
const SCALE = [1.12, 1.05, 0.96, 1.02, 0.9, 1.08, 0.99, 1.03];
const KEEP = [100, 96, 92, 98, 90, 94, 97, 95];
async function replay({ target, maxGb, maxPass }) {
  const bounds = (await q("select date_trunc('month', min(invoice_ts)) lo, date_trunc('month', max(invoice_ts)) + interval '1 month' hi from bulk_order_lines where pass=0")).rows[0];
  if (!bounds.lo) throw new Error("pass 0 is empty: load --uci first");
  for (let k = 1; k <= maxPass; k++) {
    const have = Number((await q("select count(*)::bigint n from bulk_order_lines")).rows[0].n);
    if (have >= target) { log(`target reached: ${have} rows >= ${target}`); return true; }
    if (await completed("replay", k)) continue;
    const gb = await dbSizeGb();
    if (gb >= maxGb) { log(`size guard: database is ${gb.toFixed(2)} GB >= ${maxGb} GB, stopping`); return true; }
    // pass 1 ends near today (shift 14y9m); each further pass moves 2 years earlier
    const shiftMonths = 14 * 12 + 9 - 24 * (k - 1);
    const shift = `${shiftMonths} months`;
    const years = shiftMonths / 12;
    const prev = (await q("select id from bulk_load_runs where kind='replay' and pass=$1 and status in ('running','failed') order by id desc limit 1", [k])).rows[0];
    const run = prev ? prev.id : await startRun("replay", k, { shift, price_drift: `1.03^${years.toFixed(2)}` });
    if (prev) await q("update bulk_load_runs set status='running' where id=$1", [run]);
    let rows = 0;
    try {
      for (let m = new Date(bounds.lo); m < new Date(bounds.hi); m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
        const next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
        // month batches are atomic: if this source month is already present in the pass, skip it (resume)
        const done = await q("select 1 from bulk_order_lines where pass=$1 and invoice_ts >= $2::timestamptz + $3::interval and invoice_ts < $4::timestamptz + $3::interval limit 1", [k, m.toISOString(), shift, next.toISOString()]);
        if (done.rowCount) continue;
        if (outOfTime()) { await q("update bulk_load_runs set rows_loaded=(select count(*) from bulk_order_lines where pass=$1) where id=$2", [k, run]); log(`time budget reached during replay pass ${k} - re-run the same command to resume`); return false; }
        const r = await q(
          `insert into bulk_order_lines (invoice_ts,pass,src_row,invoice,sku,description,quantity,unit_price,line_total,customer_id,country,is_cancel,currency)
           select ts, $2::smallint, src_row, inv, sku, description, qty, p, qty*p, cust, country, is_cancel, currency
           from (
             select invoice_ts + $1::interval as ts, src_row, 'R' || $2::text || '-' || invoice as inv, sku, description,
               (sign(quantity) * greatest(1, round(abs(quantity) * $6::numeric * (0.75 + (abs(hashtext(invoice || sku || $2::text)::bigint) % 51) / 100.0))))::int as qty,
               round(unit_price * power(1.03, $3::numeric), 4) as p,
               case when customer_id is null then null else customer_id || '-R' || $2::text end as cust,
               country, is_cancel, currency
             from bulk_order_lines where pass = 0 and invoice_ts >= $4 and invoice_ts < $5
               and (abs(hashtext(invoice || $2::text || 'keep')::bigint) % 100) < $7::int
           ) s on conflict do nothing`,
          [shift, k, years.toFixed(4), m.toISOString(), next.toISOString(), SCALE[(k - 1) % SCALE.length], KEEP[(k - 1) % KEEP.length]]);
        rows += r.rowCount;
      }
      const all = Number((await q("select count(*) n from bulk_order_lines where pass=$1", [k])).rows[0].n);
      await finishRun(run, all);
      log(`replay pass ${k}: ${all} rows (shift ${shift}); db ${(await dbSizeGb()).toFixed(2)} GB`);
    } catch (e) { await finishRun(run, rows, "failed"); throw e; }
  }
  return true;
}

// ---------- compression (keeps millions of rows cheap on Tiger) ----------
async function compressOld() {
  const chunks = (await q(`select c::text as chunk from show_chunks('bulk_order_lines', older_than => interval '60 days') c
    where not exists (select 1 from timescaledb_information.chunks i where i.chunk_schema || '.' || i.chunk_name = c::text and i.is_compressed)`)).rows;
  let n = 0;
  for (const { chunk } of chunks) {
    if (outOfTime()) { log(`time budget reached: compressed ${n}/${chunks.length} chunks - re-run --compress to continue`); return false; }
    await q("select compress_chunk($1::regclass, if_not_compressed => true)", [chunk]); n++;
  }
  log(`compressed ${n} chunks`, `db ${(await dbSizeGb()).toFixed(2)} GB`);
  return true;
}

// ---------- continuous aggregates ----------
async function aggregates() {
  await q(`create materialized view if not exists bulk_sales_daily with (timescaledb.continuous) as
    select time_bucket('1 day', invoice_ts) as day, country,
      coalesce(sum(line_total) filter (where not is_cancel), 0) as revenue,
      coalesce(sum(quantity) filter (where not is_cancel), 0) as units,
      coalesce(sum(-line_total) filter (where is_cancel), 0) as refunds,
      count(*) as lines
    from bulk_order_lines group by 1, 2 with no data`);
  await q(`create materialized view if not exists bulk_product_monthly with (timescaledb.continuous) as
    select time_bucket('1 month', invoice_ts) as month, sku,
      coalesce(sum(line_total) filter (where not is_cancel), 0) as revenue,
      coalesce(sum(quantity) filter (where not is_cancel), 0) as units,
      count(*) as lines
    from bulk_order_lines group by 1, 2 with no data`);
  for (const v of ["bulk_sales_daily", "bulk_product_monthly"]) { await q(`call refresh_continuous_aggregate('${v}', null, null)`); log("refreshed", v); }
}

async function stats() {
  // cheap on purpose: exact distinct counts over millions of rows need more memory than a small Tiger instance has
  const r = (await q(`select (select count(*) from bulk_order_lines) lines, (select count(*) from bulk_order_lines where pass=0) real_lines,
    (select count(*) from bulk_products) products, (select min(day)::date from bulk_sales_daily) first_day, (select max(day)::date from bulk_sales_daily) last_day`)).rows[0];
  log("stats", JSON.stringify(r), `db ${(await dbSizeGb()).toFixed(2)} GB`);
}

try {
  let finished = true;
  if (args.off) finished = (await loadOff(expand(args.off))) && finished;
  if (finished && args.uci) finished = await loadUci(expand(args.uci));
  if (finished && args.replay) finished = await replay({ target: num(args["target-rows"], 5_000_000), maxGb: num(args["max-gb"], 8), maxPass: num(args["max-pass"], 8) });
  if (args.compress) finished = (await compressOld()) && finished;
  if (finished && (args.aggregates || args.uci || args.replay)) await aggregates();
  await stats();
  log(finished ? "DONE" : "PARTIAL: re-run the same command to continue");
} finally { await db.end(); }
