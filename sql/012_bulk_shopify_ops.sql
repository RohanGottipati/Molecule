-- Shopify bulk mutation operations run server-side (async, up to 24h) so the fill needs no long-lived client process.
alter table bulk_shopify_fill add column if not exists op_id text;
alter table bulk_shopify_fill add column if not exists error text;
create table if not exists bulk_shopify_ops (
  op_id text primary key,             -- gid://shopify/BulkOperation/...
  store text not null,
  submitted_at timestamptz not null default now(),
  line_count integer not null,
  status text not null default 'SUBMITTED',
  collected_at timestamptz,
  ok_count integer,
  error_count integer
);
create index if not exists bulk_shopify_ops_open_idx on bulk_shopify_ops (store) where collected_at is null;
