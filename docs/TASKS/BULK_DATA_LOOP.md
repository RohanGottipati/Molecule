# Bulk data loop: real datasets at scale (Tiger + Shopify)

Owner: Emaad (Shopify). Written Sat Sep 19 2026.

Goal: more data means harder queries and a better demo. Millions of rows go into Tiger (TimescaleDB), where joins, window functions and rollups run fast. A smaller real-product catalog goes into the Shopify dev stores, so Admin looks full without slowing the sync or the UI.

## 1. Where the data comes from

| Dataset | Licence | What we use | Where it lands |
|---|---|---|---|
| UCI Online Retail II | CC BY 4.0 | 1,032,918 real invoice lines from a UK online retailer (Dec 2009 to Dec 2011), service codes and non-positive prices removed, overlapping December 2010 rows de-duplicated | `bulk_order_lines` (pass 0) |
| Open Food Facts | ODbL | 107,420 real food products (name, brand, category, Nutri-Score, NOVA, per-100g nutrition, ingredients). OFF has no prices, so prices are synthetic and flagged (`price_is_synthetic`, Shopify tag `synthetic-price`) | `bulk_products`, then Shopify |

Replay passes (`pass` 1 to 8) are derived data, not real: each re-times the real pass into other years, gives customers new ids, applies 3% yearly price drift, a per-pass volume scale and keep-rate, and per-line quantity jitter. Pass 1 ends near today, each further pass is 2 years earlier, so the series runs continuously from 2009 to Sep 2026. Say this out loud in the demo: "1M real lines, grown to 5M by replay". `pass = 0` filters to the real rows only.

## 2. Tiger tables (migrations 010, 011, 012)

- `bulk_order_lines`: hypertable on `invoice_ts` (1-month chunks), compression after 60 days, indexes on sku, customer, invoice.
- `bulk_products`: one row per SKU (UCI derived rows plus OFF), `bulk_load_runs`: what has been loaded and when.
- Continuous aggregates: `bulk_sales_daily` (revenue, refunds, units by day and country), `bulk_product_monthly` (revenue and units by month and SKU).
- `bulk_shopify_fill`, `bulk_shopify_ops`: which product went into which store, and the state of each Shopify bulk operation.

Current size: 5,022,872 order lines plus 112,141 products, about 1.8 GB database after compression.

## 3. Scripts (`scripts/bulk/`)

Always run from the repo root with both env files: `node --env-file=.env --env-file=.env.local scripts/bulk/<script>`.

| Script | Purpose |
|---|---|
| `prep_uci.py`, `prep_off.py` | convert the raw downloads to slim CSVs (run once) |
| `bulk-load.mjs` | `--uci=<csv> --off=<csv>` load real data; `--replay --target-rows=N` grow it; `--compress`, `--aggregates`, `--stats`. Every step resumes, `--max-seconds` bounds one run |
| `shopify-catalog-fill.mjs` | `--bulk` submits Shopify bulk operations (server-side, about 7 products per second per store); `--collect` records results; without flags it upserts sequentially (small top-ups) |
| `demo-queries.mjs` | 7 showcase queries with timings |
| `run-loop.sh` | the loop: replay, collect, submit, compress, sleep, repeat. Safe to stop and restart |

Raise the caps with env vars: `TARGET_ROWS=10000000 PER_STORE=20000 scripts/bulk/run-loop.sh`. A size guard (`--max-gb`, default 8) stops the replay before Tiger fills up.

## 4. Why Shopify only gets about 20,000 products

Shopify's API allows a few product writes per second per store, and every full sync reads 15 products per request. So the Shopify side stays at "looks full in Admin" (10,000 per store into `snackbox` and `basegoods`, routed by food category), and Shopify's bulk mutation API does the writing on Shopify's servers, no long-running client needed. The millions of rows live in Tiger.

## 5. Demo queries (all measured on Tiger, 5M rows)

| Query | Time |
|---|---|
| Revenue by year (continuous aggregate) | 0.1 s |
| Seasonality by month (window over the aggregate) | 0.0 s |
| Top products by lifetime revenue | 5.8 s |
| RFM customer segments (NTILE) | 4.5 s |
| Customer cohort retention | 4.2 s |
| Market-basket pairs (self-join, one quarter) | 24 s |
| Nutrition by Nutri-Score (112k products) | 0.4 s |

The slow one (basket pairs) is the "look how much data this is" moment. The aggregates are the "and it is still instant" moment.

## 6. Risks and notes

- Demo tag: every OFF product in Shopify carries `MOLECULE_DEMO` and `synthetic-price`. Prices are not real.
- `shopify-sync.mjs` reads every product at 15 per page. With 20k more products it takes noticeably longer. Use `--only=claims` for the fast capacity loop, and `--store=` to limit it.
- Teammates' orchestrator queries Shopify for supplier catalogs. The new food products sit in SnackBox and BaseGoods only, and none match capacity-signal titles, so capacity claims are unaffected.
- Do not run `drop_chunks` without a range: pass 0 (real data) lives in chunks before 2012-01-01.
- Background processes started from Claude tool calls die when the call ends. Run `run-loop.sh` in your own terminal (`caffeinate -i` or tmux) to keep the loop going.
- Two long-lived `INSERT INTO fulfillment_samples` sessions were seen in Tiger during this work. They are not from these scripts.
