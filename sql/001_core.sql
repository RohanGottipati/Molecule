-- 001_core.sql
-- Core relational schema for Molecule OS (Tiger Data / PostgreSQL).
-- Column/table naming here is internal; the JSON payloads that flow between
-- services use the camelCase field names defined in packages/contracts.

create extension if not exists pgcrypto; -- gen_random_uuid()

create table if not exists merchants (
  merchant_id             text primary key,
  name                    text not null,
  backboard_assistant_id  text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists merchant_stores (
  store_id        text primary key default gen_random_uuid()::text,
  merchant_id     text not null references merchants(merchant_id) on delete cascade,
  shopify_domain  text not null,
  created_at      timestamptz not null default now()
);

-- Mirrors MerchantCapabilitySchema in packages/contracts.
create table if not exists capabilities (
  capability_id  text primary key,
  merchant_id    text not null references merchants(merchant_id) on delete cascade,
  kind           text not null check (kind in ('SUPPLY', 'TRANSFORM', 'ASSEMBLE', 'FULFILL')),
  name           text not null,
  description    text,
  capability_json jsonb not null, -- full MerchantCapability, source of truth for the API
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_capabilities_merchant on capabilities(merchant_id);
create index if not exists idx_capabilities_kind on capabilities(kind);

create table if not exists merchant_policies (
  policy_id    text primary key default gen_random_uuid()::text,
  merchant_id  text not null references merchants(merchant_id) on delete cascade,
  policy_text  text not null,
  source       text,
  created_at   timestamptz not null default now()
);

create table if not exists merchant_documents (
  document_id  text primary key default gen_random_uuid()::text,
  merchant_id  text not null references merchants(merchant_id) on delete cascade,
  kind         text not null, -- catalog | pricing | equipment | shipping | other
  source_uri   text,
  version      int not null default 1,
  observed_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- Mirrors CanonicalClaimSchema in packages/contracts. This is the Rox layer:
-- every extracted fact becomes a row here, never a direct overwrite.
create table if not exists canonical_claims (
  claim_id              text primary key,
  merchant_id           text not null references merchants(merchant_id) on delete cascade,
  field                 text not null,
  normalized_value      jsonb not null,
  normalized_unit       text,
  source_kind           text not null check (source_kind in ('shopify', 'csv', 'document', 'note', 'api', 'manual')),
  source_reference      text not null,
  source_checksum       text,
  observed_at           timestamptz,
  ingested_at           timestamptz not null default now(),
  source_authority      numeric not null check (source_authority between 0 and 1),
  extraction_confidence numeric not null check (extraction_confidence between 0 and 1),
  resolution_status     text not null default 'active'
                         check (resolution_status in ('active', 'superseded', 'conflicted', 'quarantined', 'unknown')),
  evidence_text         text,
  created_at            timestamptz not null default now()
);
create index if not exists idx_claims_entity_field on canonical_claims(merchant_id, field, resolution_status);
create index if not exists idx_claims_ingested_at on canonical_claims(ingested_at desc);

create table if not exists claim_conflicts (
  conflict_id       text primary key default gen_random_uuid()::text,
  merchant_id       text not null references merchants(merchant_id) on delete cascade,
  field             text not null,
  claim_ids         text[] not null,
  status            text not null default 'conflicted' check (status in ('conflicted', 'resolved')),
  resolved_claim_id text references canonical_claims(claim_id),
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);
create index if not exists idx_conflicts_entity_field on claim_conflicts(merchant_id, field, status);

create table if not exists customer_intents (
  intent_id   text not null,
  version     int not null,
  intent_json jsonb not null, -- ProductIntent
  created_at  timestamptz not null default now(),
  primary key (intent_id, version)
);

create table if not exists quotes (
  offer_id      text primary key default gen_random_uuid()::text,
  merchant_id   text not null references merchants(merchant_id) on delete cascade,
  intent_id     text not null,
  capability_id text not null references capabilities(capability_id),
  quote_json    jsonb not null, -- QuoteResponse
  created_at    timestamptz not null default now()
);

create table if not exists reservations (
  reservation_id  text primary key default gen_random_uuid()::text,
  merchant_id     text not null references merchants(merchant_id) on delete cascade,
  capability_id   text not null references capabilities(capability_id),
  order_id        text not null,
  quantity        numeric not null check (quantity > 0),
  status          text not null default 'active' check (status in ('active', 'released', 'expired')),
  action_key      text not null unique,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);
create index if not exists idx_reservations_capability_status on reservations(capability_id, status);

create table if not exists production_plans (
  plan_id       text primary key,
  order_id      text not null,
  intent_version int not null,
  status        text not null check (status in ('VALID', 'UNSAT')),
  plan_json     jsonb not null, -- ProductionPlan
  created_at    timestamptz not null default now()
);
create index if not exists idx_plans_order on production_plans(order_id, created_at desc);

create table if not exists composite_products (
  product_id           text primary key default gen_random_uuid()::text,
  plan_id              text not null references production_plans(plan_id),
  shopify_product_gid  text not null,
  shopify_variant_gid  text,
  created_at           timestamptz not null default now()
);

create table if not exists supplier_jobs (
  job_id                  text primary key default gen_random_uuid()::text,
  plan_id                 text not null references production_plans(plan_id),
  node_id                 text not null,
  merchant_id             text not null references merchants(merchant_id),
  shopify_draft_order_gid text,
  status                  text not null default 'created' check (status in ('created', 'superseded', 'completed')),
  created_at              timestamptz not null default now()
);

create table if not exists external_resource_refs (
  ref_id       text primary key default gen_random_uuid()::text,
  order_id     text not null,
  kind         text not null, -- shopify_product | shopify_order | shopify_draft_order
  external_id  text not null,
  created_at   timestamptz not null default now()
);

create table if not exists order_agent_threads (
  thread_id    text primary key,
  merchant_id  text not null references merchants(merchant_id) on delete cascade,
  order_id     text not null,
  created_at   timestamptz not null default now()
);

create table if not exists idempotency_records (
  action_key   text primary key,
  result_json  jsonb,
  created_at   timestamptz not null default now()
);

-- MoleculeEvent envelope (packages/events writes here).
create table if not exists molecule_events (
  event_id    text primary key,
  trace_id    text not null,
  order_id    text,
  plan_id     text,
  merchant_id text,
  event_type  text not null,
  severity    text not null check (severity in ('DEBUG', 'INFO', 'WARN', 'ERROR')),
  source      text not null check (source in ('openai', 'rox', 'backboard', 'tiger', 'shopify', 'solver', 'ui')),
  ts          timestamptz not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_events_order on molecule_events(order_id, ts);
create index if not exists idx_events_trace on molecule_events(trace_id, ts);
