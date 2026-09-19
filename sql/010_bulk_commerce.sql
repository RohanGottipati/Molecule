-- Bulk commerce data: real open datasets loaded at scale so the demo can run heavy queries.
--   * UCI Online Retail II (CC BY 4.0): ~1M real invoice lines from a UK online retailer (pass 0)
--   * Open Food Facts (ODbL): ~100k real food products (prices are synthetic and flagged)
-- Replay passes (pass > 0) re-time pass 0 into other years with new customer ids so the table reaches
-- millions of rows. They are derived data and are labelled by `pass`. Additive: safe next to 001-009.

create table if not exists bulk_load_runs (
  id bigserial primary key,
  kind text not null,                 -- 'uci_pass0' | 'off_products' | 'replay'
  pass smallint,
  rows_loaded bigint not null default 0,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  detail jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists bulk_load_runs_done_uq on bulk_load_runs (kind, coalesce(pass, -1)) where status = 'completed';

create table if not exists bulk_products (
  sku text primary key,               -- UCI stock code or Open Food Facts barcode
  source text not null check (source in ('uci_online_retail_ii', 'open_food_facts')),
  title text not null,
  brand text,
  category text,
  subcategory text,
  quantity_label text,
  countries text,
  nutriscore text,
  nova_group numeric,
  kcal_100g numeric,
  sugars_100g numeric,
  fat_100g numeric,
  protein_100g numeric,
  salt_100g numeric,
  allergens text,
  ingredients text,
  scans numeric,
  price numeric(12, 4),
  currency text not null,
  price_is_synthetic boolean not null default false,
  loaded_at timestamptz not null default now()
);
create index if not exists bulk_products_source_cat_idx on bulk_products (source, category);
create index if not exists bulk_products_title_trgm_idx on bulk_products using gin (to_tsvector('simple', title));

create table if not exists bulk_order_lines (
  invoice_ts timestamptz not null,
  pass smallint not null,
  src_row integer not null,
  invoice text not null,
  sku text not null,
  description text,
  quantity integer not null,
  unit_price numeric(12, 4) not null,
  line_total numeric(14, 4) not null,
  customer_id text,
  country text,
  is_cancel boolean not null default false,
  currency text not null default 'GBP',
  primary key (invoice_ts, pass, src_row)
);
select create_hypertable('bulk_order_lines', 'invoice_ts', chunk_time_interval => interval '1 month', if_not_exists => true);
create index if not exists bulk_order_lines_sku_ts_idx on bulk_order_lines (sku, invoice_ts desc);
create index if not exists bulk_order_lines_customer_idx on bulk_order_lines (customer_id, invoice_ts desc);
create index if not exists bulk_order_lines_invoice_idx on bulk_order_lines (invoice, pass);

alter table bulk_order_lines set (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'country',
  timescaledb.compress_orderby = 'invoice_ts desc'
);
select add_compression_policy('bulk_order_lines', interval '60 days', if_not_exists => true);
