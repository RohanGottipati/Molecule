-- 009_shopify_catalog.sql
-- Read-model mirror of supplier catalogs pulled from Shopify (scripts/shopify-sync.mjs).
-- Additive. Shopify stays the system of record; these tables are a queryable snapshot.

create table if not exists shopify_sync_runs (
  run_id       text primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  stores       jsonb not null default '[]'::jsonb,
  counts       jsonb not null default '{}'::jsonb,
  error        text
);

create table if not exists shopify_products (
  product_gid   text primary key,
  shop_domain   text not null,
  merchant_id   text not null references merchants(merchant_id),
  handle        text not null,
  title         text not null,
  product_type  text,
  vendor        text,
  status        text not null,
  tags          jsonb not null default '[]'::jsonb,
  description   text,
  synced_at     timestamptz not null default now(),
  run_id        text references shopify_sync_runs(run_id)
);
create index if not exists idx_shopify_products_merchant on shopify_products(merchant_id);
create index if not exists idx_shopify_products_shop_handle on shopify_products(shop_domain, handle);
create index if not exists idx_shopify_products_tags on shopify_products using gin(tags);

create table if not exists shopify_variants (
  variant_gid        text primary key,
  product_gid        text not null references shopify_products(product_gid) on delete cascade,
  shop_domain        text not null,
  merchant_id        text not null references merchants(merchant_id),
  sku                text,
  title              text,
  options            jsonb not null default '[]'::jsonb,
  price              numeric,
  currency           text,
  tracked            boolean not null default false,
  available          integer,
  inventory_item_gid text,
  synced_at          timestamptz not null default now()
);
create index if not exists idx_shopify_variants_product on shopify_variants(product_gid);
create index if not exists idx_shopify_variants_merchant on shopify_variants(merchant_id);
create index if not exists idx_shopify_variants_sku on shopify_variants(sku);

-- Tracked "capacity" signal products: inventory equals units available per day.
create or replace view shopify_capacity_signals as
select p.merchant_id, p.shop_domain, p.product_gid, p.title, v.variant_gid, v.inventory_item_gid,
       v.available as units_available, p.synced_at
from shopify_products p join shopify_variants v on v.product_gid = p.product_gid
where p.tags ? 'capacity' and v.tracked and p.status <> 'MISSING';
