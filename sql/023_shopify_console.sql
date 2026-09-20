-- 023_shopify_console.sql
-- Read-model mirror of Shopify commerce records (orders, customers, sales rollups) that back
-- the store console in the web app. Additive; extends the catalog mirror in 009.
--
-- Provenance rules, per docs/TASKS/SHOPIFY_DATA_PIPELINE.md section 2:
--   * Shopify stays the system of record. These tables are a queryable snapshot, never truth.
--   * Every row records whether it is synthetic and where it came from.
--   * Customers and sales rollups have NO live counterpart: `read_customers` is not a granted
--     scope on the dev stores (docs/TASKS/SHOPIFY_LOOP.md section 1). They exist only to give
--     the console something to display and are never read by Reality, the solver, or claim
--     resolution. `synthetic` is NOT NULL DEFAULT true for exactly that reason.

create table if not exists shopify_orders (
  order_gid         text primary key,
  shop_domain       text not null,
  merchant_id       text not null references merchants(merchant_id),
  name              text not null,
  created_at        timestamptz not null,
  processed_at      timestamptz,
  financial_status  text,
  fulfillment_status text,
  currency          text not null,
  subtotal          numeric not null default 0,
  total             numeric not null default 0,
  customer_gid      text,
  tags              jsonb not null default '[]'::jsonb,
  synthetic         boolean not null default true,
  source_reference  text not null,
  synced_at         timestamptz not null default now(),
  run_id            text references shopify_sync_runs(run_id)
);
create index if not exists idx_shopify_orders_shop on shopify_orders(shop_domain, created_at desc);
create index if not exists idx_shopify_orders_merchant on shopify_orders(merchant_id);
create index if not exists idx_shopify_orders_customer on shopify_orders(customer_gid);

create table if not exists shopify_order_line_items (
  line_item_gid text primary key,
  order_gid     text not null references shopify_orders(order_gid) on delete cascade,
  shop_domain   text not null,
  title         text not null,
  quantity      integer not null check (quantity > 0),
  sku           text,
  variant_gid   text,
  product_gid   text,
  unit_price    numeric not null default 0,
  total_price   numeric not null default 0,
  synced_at     timestamptz not null default now()
);
create index if not exists idx_shopify_line_items_order on shopify_order_line_items(order_gid);
create index if not exists idx_shopify_line_items_variant on shopify_order_line_items(variant_gid);

create table if not exists shopify_customers (
  customer_gid     text primary key,
  shop_domain      text not null,
  merchant_id      text not null references merchants(merchant_id),
  display_name     text not null,
  email            text,
  created_at       timestamptz not null,
  order_count      integer not null default 0,
  amount_spent     numeric not null default 0,
  currency         text not null,
  tags             jsonb not null default '[]'::jsonb,
  -- Always true today: there is no granted scope that could produce a real customer record.
  synthetic        boolean not null default true,
  source_reference text not null,
  synced_at        timestamptz not null default now(),
  run_id           text references shopify_sync_runs(run_id)
);
create index if not exists idx_shopify_customers_shop on shopify_customers(shop_domain);

create table if not exists shopify_sales_daily (
  shop_domain      text not null,
  day              date not null,
  merchant_id      text not null references merchants(merchant_id),
  order_count      integer not null default 0,
  units            integer not null default 0,
  gross_sales      numeric not null default 0,
  currency         text not null,
  synthetic        boolean not null default true,
  source_reference text not null,
  synced_at        timestamptz not null default now(),
  primary key (shop_domain, day)
);
create index if not exists idx_shopify_sales_merchant on shopify_sales_daily(merchant_id, day desc);

-- Convenience read model for the console's per-store summary card.
create or replace view shopify_store_summary as
select
  p.shop_domain,
  p.merchant_id,
  count(distinct p.product_gid)                          as product_count,
  count(v.variant_gid)                                   as variant_count,
  count(distinct v.variant_gid) filter (where v.tracked) as tracked_variant_count,
  max(p.synced_at)                                       as synced_at
from shopify_products p
left join shopify_variants v on v.product_gid = p.product_gid
where p.status <> 'MISSING'
group by p.shop_domain, p.merchant_id;
