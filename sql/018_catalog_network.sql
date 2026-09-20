-- Immutable import versions. Local IDs exist before Shopify provisioning.
create table catalog_versions (
  catalog_version text primary key,
  checksum text not null,
  manifest_json jsonb not null,
  report_json jsonb not null,
  imported_at timestamptz not null default now()
);
create table catalog_records (
  catalog_version text not null references catalog_versions,
  record_id text not null,
  record_type text not null,
  record_json jsonb not null,
  primary key (catalog_version, record_id)
);
create index catalog_records_type on catalog_records(catalog_version, record_type);
create table catalog_active_version (
  singleton boolean primary key default true check(singleton),
  catalog_version text not null references catalog_versions,
  previous_version text references catalog_versions
);
-- Native catalog references are attached to local IDs, never used as local IDs.
create table catalog_variant_mappings (
  catalog_version text not null,
  variant_id text not null,
  shop_domain text not null,
  product_gid text not null references shopify_products(product_gid),
  variant_gid text not null references shopify_variants(variant_gid),
  primary key(catalog_version,variant_id),
  foreign key(catalog_version,variant_id) references catalog_records(catalog_version,record_id)
);
-- One row per physical stock pool/machine, shared across bindings and versions.
create table catalog_resource_state (
  resource_id text primary key,
  merchant_id text not null references merchants,
  kind text not null check(kind in ('inventory','processing')),
  unit text not null,
  period_minutes integer,
  available numeric not null check(available>=0),
  observed_at timestamptz not null,
  source_reference text not null,
  synthetic boolean not null,
  status text not null check(status in ('known','unknown','conflicted')),
  check ((kind='processing')=(period_minutes is not null)),
  check (period_minutes is null or period_minutes>0)
);
create table catalog_resource_reservations (
  action_key text primary key,
  request_json jsonb not null,
  order_id text not null,
  plan_id text not null,
  node_id text not null,
  catalog_version text not null references catalog_versions,
  resource_id text not null references catalog_resource_state,
  quantity numeric not null check(quantity>0),
  starts_at timestamptz,
  completes_at timestamptz,
  status text not null default 'active' check(status in ('active','released')),
  trace_id text not null,
  check ((starts_at is null and completes_at is null) or completes_at>starts_at)
);
create index catalog_reservations_active on catalog_resource_reservations(resource_id) where status='active';
