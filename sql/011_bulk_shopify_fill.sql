-- Tracks which Open Food Facts products have been pushed into which Shopify dev store,
-- so scripts/bulk/shopify-catalog-fill.mjs can resume and never duplicates a product.
create table if not exists bulk_shopify_fill (
  store text not null,
  sku text not null references bulk_products (sku),
  product_gid text,
  filled_at timestamptz not null default now(),
  primary key (store, sku)
);
create index if not exists bulk_shopify_fill_store_idx on bulk_shopify_fill (store, filled_at desc);
