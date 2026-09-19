-- Additive handoff only. These staging records are NOT executable capabilities.
-- Existing merchants, Shopify mirrors and canonical claims remain authoritative.
create table catalog_categories (
  category_id text primary key check (btrim(category_id) <> ''),
  label text not null unique check (btrim(label) <> ''),
  target_recipe_count integer not null default 0 check (target_recipe_count >= 0),
  source_reference text not null check (btrim(source_reference) <> ''),
  created_at timestamptz not null default now()
);

create table catalog_import_batches (
  batch_id text primary key check (btrim(batch_id) <> ''),
  manifest_version text not null check (btrim(manifest_version) <> ''),
  status text not null default 'awaiting_delivery'
    check (status in ('awaiting_delivery', 'receiving', 'ready_for_validation', 'rejected')),
  source_reference text not null check (btrim(source_reference) <> ''),
  trace_id text not null check (btrim(trace_id) <> ''),
  action_key text not null unique check (btrim(action_key) <> ''),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create table catalog_import_records (
  batch_id text not null references catalog_import_batches(batch_id),
  record_kind text not null check (record_kind in
    ('merchant', 'product', 'variant', 'capability', 'resource', 'fact', 'binding', 'relationship')),
  local_id text not null check (btrim(local_id) <> ''),
  category_id text references catalog_categories(category_id),
  source_reference text not null check (btrim(source_reference) <> ''),
  observed_at timestamptz not null,
  is_synthetic boolean not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'received' check (status in ('received', 'quarantined')),
  validation_errors jsonb not null default '[]'::jsonb
    check (jsonb_typeof(validation_errors) = 'array'),
  trace_id text not null check (btrim(trace_id) <> ''),
  action_key text not null unique check (btrim(action_key) <> ''),
  received_at timestamptz not null default now(),
  primary key (batch_id, record_kind, local_id)
);
create index idx_catalog_import_records_category on catalog_import_records(category_id);

comment on table catalog_categories is
  'Catalog taxonomy and release targets, not verified product coverage. Only supplied labels are registered.';
comment on table catalog_import_batches is
  'Draft data handoff. No active catalog version or solver certification is implied by a batch status.';
comment on table catalog_import_records is
  'Raw staging envelopes with stable local IDs and provenance. Payloads require future @molecule/contracts validation before promotion. Do not query these records as executable capabilities.';
comment on column catalog_import_records.payload is
  'Untrusted source data. Preserve unknown/conflicted facts explicitly; never fill missing stock, price, lead time or capacity with guesses. Shopify GIDs may be attached after seeding.';

insert into catalog_categories(category_id, label, target_recipe_count, source_reference) values
  ('apparel', 'Apparel', 8, 'plan:broad-product-network:v1'),
  ('bags-accessories', 'Bags & Accessories', 8, 'plan:broad-product-network:v1'),
  ('tech-accessories', 'Tech Accessories', 8, 'plan:broad-product-network:v1'),
  ('desk-office', 'Desk & Office', 8, 'plan:broad-product-network:v1'),
  ('gaming', 'Gaming', 8, 'plan:broad-product-network:v1'),
  ('home-decor', 'Home Decor', 8, 'plan:broad-product-network:v1'),
  ('kitchen-dining', 'Kitchen & Dining', 8, 'plan:broad-product-network:v1'),
  ('fitness', 'Fitness', 8, 'plan:broad-product-network:v1'),
  ('pets', 'Pets', 8, 'plan:broad-product-network:v1'),
  ('travel', 'Travel', 8, 'plan:broad-product-network:v1'),
  ('gifts', 'Gifts', 8, 'plan:broad-product-network:v1'),
  ('3d-printing-maker', '3D Printing / Maker', 8, 'plan:broad-product-network:v1');

insert into catalog_import_batches
  (batch_id, manifest_version, source_reference, trace_id, action_key, metadata)
values (
  'broad-network-v1', 'draft-v1', 'plan:broad-product-network:v1',
  'catalog-handoff-017', 'catalog-handoff:017:broad-network-v1',
  '{"stage":"schema_ready_awaiting_data", "targetStores":14,
    "targetCategoryLabels":32, "registeredCategoryLabels":12,
    "pendingCategoryLabels":20, "targetRecipes":100,
    "crossCategoryBundles":["onboarding","creator desk","conference","outdoor gift"],
    "targetLiveDemonstrations":13, "currency":"CAD", "fulfilmentCountry":"CA",
    "plannedNewStores":["Needle North","TechWorks","HomeWorks","MakerWorks","SurfaceWorks","RouteShip"],
    "sampleRecipeCountRequired":20, "executable":false,
    "nextStep":"Agree shared manifest contract and validate teammate delivery before promotion"}'::jsonb
);

create view catalog_handoff_coverage as
select c.category_id, c.label, c.target_recipe_count,
  count(r.local_id) as staged_record_count,
  count(r.local_id) filter (where r.status = 'quarantined') as quarantined_record_count
from catalog_categories c
left join catalog_import_records r on r.category_id = c.category_id
group by c.category_id, c.label, c.target_recipe_count;

insert into molecule_events(event_id, trace_id, event_type, severity, source, ts, payload)
values ('b8908189-d48f-4a81-8dca-8f6d9be29884', 'catalog-handoff-017',
  'catalog.handoff.prepared', 'INFO', 'tiger', now(),
  '{"actionKey":"catalog-handoff:017:broad-network-v1","batchId":"broad-network-v1",
    "migration":"017_broad_catalog_handoff.sql","registeredCategories":12,
    "pendingCategoryLabels":20,"executable":false,
    "tables":["catalog_categories","catalog_import_batches","catalog_import_records"]}'::jsonb);
