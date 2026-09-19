-- 013_rox_ingest.sql
-- Rox ingestion: the agentic path from a messy artifact to a certified fact.
--
-- Shape of the pipeline this supports:
--   corpus -> raw_artifacts (byte-faithful) -> rox_extractions (LLM candidates, evidence required)
--   -> canonical_claims (normalized) | quarantined_claims (refused) -> canonical_resolutions | claim_conflicts
--   -> rox_review_queue (what a human must decide) -> Shopify Admin write-back.
--
-- Additive only. Existing tables gain nullable columns; nothing here rewrites 001-012.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- artifacts

-- An artifact arrives before we know who sent it. merchant_id stays pointed at
-- the sentinel below until entity resolution links it, and merchant_hint keeps
-- the raw alias text ("Thread Forge Inc.") so the link is auditable.
insert into merchants (merchant_id, name)
  values ('m-unresolved', 'Unresolved (pending entity resolution)')
  on conflict (merchant_id) do nothing;

alter table raw_artifacts add column if not exists media_type text;
alter table raw_artifacts add column if not exists content_text text;
alter table raw_artifacts add column if not exists parse_status text not null default 'pending';
alter table raw_artifacts add column if not exists parse_error text;
alter table raw_artifacts add column if not exists merchant_hint text;
alter table raw_artifacts add column if not exists batch_id text;
alter table raw_artifacts add column if not exists source_path text;
alter table raw_artifacts add column if not exists byte_size integer;
alter table raw_artifacts add column if not exists chaos_profile jsonb not null default '{}'::jsonb;
do $$ begin
  alter table raw_artifacts add constraint raw_artifacts_parse_status_chk
    check (parse_status in ('pending', 'parsed', 'failed', 'skipped'));
exception when duplicate_object then null; end $$;
create index if not exists idx_raw_artifacts_batch on raw_artifacts(batch_id, received_at desc);
create index if not exists idx_raw_artifacts_parse_status on raw_artifacts(parse_status) where parse_status <> 'parsed';
-- The same bytes arriving twice from the same place is one artifact. The same
-- bytes from a *different* source is corroboration, not a duplicate, so the
-- dedupe key is the pair.
create unique index if not exists uq_raw_artifacts_checksum_source
  on raw_artifacts(checksum, source_reference);

-- Quarantine already exists (artifact_id + reason). These columns say *what*
-- was refused, so a reviewer sees the field and the value we would not guess at.
alter table quarantined_claims add column if not exists run_id text;
alter table quarantined_claims add column if not exists extraction_id text;
alter table quarantined_claims add column if not exists merchant_hint text;
alter table quarantined_claims add column if not exists field text;
alter table quarantined_claims add column if not exists raw_value jsonb;
alter table quarantined_claims add column if not exists stage text;
create index if not exists idx_quarantine_field on quarantined_claims(field, created_at desc);

-- ---------------------------------------------------------------- runs

create table if not exists rox_ingest_runs (
  run_id        text primary key,
  batch_id      text,
  seed          bigint,
  mode          text not null default 'real' check (mode in ('real', 'mock', 'dry')),
  status        text not null default 'running' check (status in ('running', 'completed', 'failed', 'aborted')),
  stage_counts  jsonb not null default '{}'::jsonb,
  models        jsonb not null default '{}'::jsonb,
  cost_usd      numeric(10, 4) not null default 0,
  budget_usd    numeric(10, 4),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  error         text
);
create index if not exists idx_rox_runs_started on rox_ingest_runs(started_at desc);

-- ---------------------------------------------------------------- extraction

-- One row per candidate fact the model proposed. A candidate without an
-- evidence span is never written here: the pipeline drops it and counts it as
-- a hallucination. Nothing in this table is trusted yet.
create table if not exists rox_extractions (
  extraction_id   text primary key,
  run_id          text not null references rox_ingest_runs(run_id) on delete cascade,
  artifact_id     text not null references raw_artifacts(artifact_id) on delete cascade,
  merchant_hint   text,
  field           text not null,
  raw_value       jsonb,
  raw_unit        text,
  evidence_text   text,
  evidence_start  integer,
  evidence_end    integer,
  confidence      numeric not null check (confidence between 0 and 1),
  ambiguity       text,
  observed_at     timestamptz,
  injection_flag  boolean not null default false,
  outcome         text not null default 'pending'
                    check (outcome in ('pending', 'claimed', 'quarantined', 'dropped', 'blocked')),
  outcome_reason  text,
  claim_id        text references canonical_claims(claim_id),
  model           text not null,
  prompt_version  text not null,
  created_at      timestamptz not null default now()
);
create index if not exists idx_rox_extractions_artifact on rox_extractions(artifact_id);
create index if not exists idx_rox_extractions_run_outcome on rox_extractions(run_id, outcome);
create index if not exists idx_rox_extractions_field on rox_extractions(field, created_at desc);

-- ---------------------------------------------------------------- entities

-- "ThreadForge" / "Thread Forge Inc." / "TF Embroidery" / threadforge-eznglsyk
-- all name one merchant. method records *how* we knew, score how sure, and
-- needs_review means we refused to merge rather than guessing.
create table if not exists rox_entity_links (
  link_id     text primary key,
  run_id      text references rox_ingest_runs(run_id) on delete set null,
  alias       text not null,
  alias_kind  text not null check (alias_kind in ('merchant', 'sku', 'capability')),
  resolved_id text,
  method      text not null check (method in ('exact', 'trgm', 'vector', 'llm', 'manual')),
  score       numeric check (score between 0 and 1),
  status      text not null default 'linked' check (status in ('linked', 'needs_review', 'rejected')),
  evidence    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create unique index if not exists uq_rox_entity_alias on rox_entity_links(alias_kind, lower(alias));
create index if not exists idx_rox_entity_status on rox_entity_links(status, alias_kind);
create index if not exists idx_rox_entity_alias_trgm on rox_entity_links using gin (alias gin_trgm_ops);

-- Blocking index for entity resolution: nearest-neighbour candidates before
-- any model is asked to adjudicate.
create table if not exists rox_alias_embeddings (
  alias       text not null,
  alias_kind  text not null check (alias_kind in ('merchant', 'sku', 'capability')),
  resolved_id text,
  embedding   vector(1536) not null,
  model       text not null,
  created_at  timestamptz not null default now(),
  primary key (alias_kind, alias)
);
create index if not exists idx_rox_alias_embedding_hnsw
  on rox_alias_embeddings using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------- review + actions

-- Everything the system refused to decide alone. A conflicted capacity, a
-- low-confidence merge, a fact nobody stated. Each row carries the action the
-- agent proposes and, where useful, the message it drafted to the supplier.
create table if not exists rox_review_queue (
  task_id         text primary key,
  run_id          text references rox_ingest_runs(run_id) on delete set null,
  kind            text not null check (kind in ('conflict', 'low_confidence_link', 'quarantine', 'missing_fact', 'injection')),
  merchant_id     text references merchants(merchant_id),
  merchant_hint   text,
  field           text,
  detail          jsonb not null default '{}'::jsonb,
  proposed_action jsonb not null default '{}'::jsonb,
  draft_message   text,
  status          text not null default 'open' check (status in ('open', 'approved', 'rejected', 'sent')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      text
);
create index if not exists idx_rox_review_open on rox_review_queue(status, kind, created_at desc);

-- ---------------------------------------------------------------- rule compiler

-- Rules the model mined from samples and that measurement accepted. Accepted
-- rules run as plain SQL over millions of rows; only the residual tail is
-- escalated back to a model.
create table if not exists rox_rules (
  rule_id        text primary key,
  domain         text not null,          -- e.g. 'off_quantity', 'uci_line_hygiene'
  pattern        text not null,
  transform      jsonb not null default '{}'::jsonb,
  sample_size    integer,
  precision_pct  numeric,
  recall_pct     numeric,
  rows_covered   bigint,
  status         text not null default 'candidate' check (status in ('candidate', 'accepted', 'rejected')),
  created_by     text not null,          -- model id, or 'human'
  created_at     timestamptz not null default now(),
  evaluated_at   timestamptz
);
create index if not exists idx_rox_rules_domain_status on rox_rules(domain, status);

-- ---------------------------------------------------------------- ground truth + scoring

-- What the corpus generator knows and the pipeline is never allowed to read.
-- Scoring is a SQL join against this table.
create table if not exists rox_truth (
  truth_id         text primary key,
  batch_id         text not null,
  artifact_id      text,
  source_path      text,
  merchant_id      text,
  field            text not null,
  true_value       jsonb,
  true_unit        text,
  observed_at      timestamptz,
  should_quarantine boolean not null default false,
  should_conflict   boolean not null default false,
  is_injection      boolean not null default false,
  chaos            jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists idx_rox_truth_batch on rox_truth(batch_id, field);
create index if not exists idx_rox_truth_path on rox_truth(source_path);

create table if not exists rox_scorecard (
  run_id     text not null references rox_ingest_runs(run_id) on delete cascade,
  metric     text not null,
  value      numeric,
  detail     jsonb not null default '{}'::jsonb,
  variant    text not null default 'agent',  -- 'agent' | 'regex_baseline'
  created_at timestamptz not null default now(),
  primary key (run_id, variant, metric)
);

-- ---------------------------------------------------------------- cost ledger

-- Operator-maintained price list. Verify against the provider's pricing page;
-- verified_at null means "assumed". Cost math reads from here so the budget
-- ceiling is auditable rather than hard-coded.
create table if not exists rox_model_prices (
  model            text primary key,
  input_per_mtok   numeric not null,
  cached_per_mtok  numeric,
  output_per_mtok  numeric not null,
  verified_at      timestamptz,
  note             text
);

create table if not exists rox_llm_calls (
  created_at    timestamptz not null default now(),
  call_id       text not null,
  run_id        text,
  stage         text not null,
  model         text not null,
  input_tokens  integer not null default 0,
  cached_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      numeric(10, 6) not null default 0,
  latency_ms    integer,
  ok            boolean not null default true,
  error         text,
  primary key (created_at, call_id)
);
create index if not exists idx_rox_llm_calls_run on rox_llm_calls(run_id, created_at desc);

-- Spend and latency over time, for the dashboard. Same guarded shape as
-- 003_aggregates.sql: the migration runner applies each file in one
-- transaction, and a plain view is the fallback without TimescaleDB.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'timescaledb') then
    perform create_hypertable('rox_llm_calls', 'created_at',
      chunk_time_interval => interval '7 days', if_not_exists => true, migrate_data => true);
    execute 'create materialized view if not exists rox_cost_hourly
      with (timescaledb.continuous, timescaledb.materialized_only = false) as
      select time_bucket(''1 hour'', created_at) as hour, model, stage,
             count(*) as calls, sum(cost_usd) as cost_usd,
             sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
             avg(latency_ms) as avg_latency_ms, count(*) filter (where not ok) as failures
      from rox_llm_calls group by 1, 2, 3 with no data';
    perform add_continuous_aggregate_policy('rox_cost_hourly',
      start_offset => interval '3 days', end_offset => interval '1 minute',
      schedule_interval => interval '5 minutes', if_not_exists => true);
  else
    execute 'create or replace view rox_cost_hourly as
      select date_trunc(''hour'', created_at) as hour, model, stage,
             count(*) as calls, sum(cost_usd) as cost_usd,
             sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
             avg(latency_ms) as avg_latency_ms, count(*) filter (where not ok) as failures
      from rox_llm_calls group by 1, 2, 3';
  end if;
end $$;

-- ---------------------------------------------------------------- read models

-- What a reviewer or the dashboard actually looks at: every live fact with the
-- artifact it came from and the sentence that justified it.
create or replace view rox_fact_provenance as
  select c.merchant_id,
         c.field,
         c.normalized_value,
         c.normalized_unit,
         c.resolution_status,
         c.source_kind,
         c.source_reference,
         c.source_authority,
         c.extraction_confidence,
         c.observed_at,
         c.ingested_at,
         e.evidence_text,
         e.ambiguity,
         e.model,
         a.artifact_id,
         a.source_path,
         a.media_type,
         a.chaos_profile
  from canonical_claims c
  left join rox_extractions e on e.claim_id = c.claim_id
  left join raw_artifacts a on a.artifact_id = e.artifact_id;

create or replace view rox_run_summary as
  select r.run_id,
         r.status,
         r.started_at,
         r.finished_at,
         r.cost_usd,
         (select count(*) from raw_artifacts a where a.batch_id = r.batch_id) as artifacts,
         (select count(*) from rox_extractions x where x.run_id = r.run_id) as candidates,
         (select count(*) from rox_extractions x where x.run_id = r.run_id and x.outcome = 'claimed') as claimed,
         (select count(*) from rox_extractions x where x.run_id = r.run_id and x.outcome = 'quarantined') as quarantined,
         (select count(*) from rox_extractions x where x.run_id = r.run_id and x.injection_flag) as injections_caught,
         (select count(*) from rox_review_queue q where q.run_id = r.run_id and q.status = 'open') as open_reviews
  from rox_ingest_runs r;
