-- 003_aggregates.sql
-- Continuous aggregates for p50/p95/p99 merchant risk, plus pgvector
-- capability search. percentile_agg needs timescaledb_toolkit; if your
-- Tiger service doesn't offer it yet, the fallback query at the bottom
-- computes percentiles the plain-SQL way instead.

create extension if not exists timescaledb_toolkit;
create extension if not exists vector;

create materialized view if not exists lead_time_hourly
with (timescaledb.continuous) as
select
  merchant_id,
  capability_id,
  time_bucket('1 hour', ts) as bucket,
  percentile_agg(actual_hours) as pct_agg,
  count(*) as sample_count
from fulfillment_samples
group by merchant_id, capability_id, bucket
with no data;

create materialized view if not exists merchant_health_5m
with (timescaledb.continuous) as
select
  merchant_id,
  time_bucket('5 minutes', ts) as bucket,
  count(*) filter (where event_type = 'merchant.quote.timeout') as timeouts,
  count(*) filter (where event_type = 'merchant.quote.received') as quotes_received
from network_events
where merchant_id is not null
group by merchant_id, bucket
with no data;

create materialized view if not exists capability_capacity_1m
with (timescaledb.continuous) as
select
  merchant_id,
  capability_id,
  time_bucket('1 minute', ts) as bucket,
  avg(value) as avg_capacity
from market_metrics
where metric = 'capacity'
group by merchant_id, capability_id, bucket
with no data;

-- Fallback: plain-SQL percentile query against the raw hypertable, for use
-- if timescaledb_toolkit isn't available on your Tiger service tier.
-- select merchant_id, capability_id,
--        percentile_cont(0.5) within group (order by actual_hours) as p50,
--        percentile_cont(0.95) within group (order by actual_hours) as p95,
--        percentile_cont(0.99) within group (order by actual_hours) as p99,
--        count(*) as sample_count
-- from fulfillment_samples
-- group by merchant_id, capability_id;

-- Vector search for capability candidates (T4). Dimension depends on the
-- embedding model used at ingestion time (1536 = text-embedding-3-small).
create table if not exists capability_embeddings (
  capability_id  text primary key references capabilities(capability_id) on delete cascade,
  embedding      vector(1536) not null,
  model          text not null,
  updated_at     timestamptz not null default now()
);
create index if not exists idx_capability_embeddings_ivfflat
  on capability_embeddings using ivfflat (embedding vector_cosine_ops);
