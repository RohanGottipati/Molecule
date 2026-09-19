-- 002_timeseries.sql
-- Tiger Data hypertables. Requires the TimescaleDB extension (Tiger Data is
-- managed Postgres + TimescaleDB, this works against a local Postgres with
-- the timescaledb extension too).

create extension if not exists timescaledb;

create table if not exists network_events (
  ts             timestamptz not null,
  event_id       text not null default gen_random_uuid()::text,
  trace_id       text not null,
  order_id       text,
  plan_id        text,
  merchant_id    text,
  event_type     text not null,
  source         text,
  severity       text,
  numeric_value  numeric,
  unit           text,
  payload        jsonb
);
select create_hypertable('network_events', by_range('ts'), if_not_exists => true);
create index if not exists idx_network_events_order on network_events (order_id, ts desc);
create index if not exists idx_network_events_merchant on network_events (merchant_id, ts desc);
create index if not exists idx_network_events_type on network_events (event_type, ts desc);

-- Historical promised-vs-actual duration samples, feeds p50/p95/p99 risk.
create table if not exists fulfillment_samples (
  ts              timestamptz not null,
  merchant_id     text not null,
  capability_id   text not null,
  promised_hours  numeric,
  actual_hours    numeric,
  success         boolean not null
);
select create_hypertable('fulfillment_samples', by_range('ts'), if_not_exists => true);
create index if not exists idx_fulfillment_merchant_cap on fulfillment_samples (merchant_id, capability_id, ts desc);

create table if not exists market_metrics (
  ts             timestamptz not null,
  merchant_id    text not null,
  capability_id  text,
  metric         text not null, -- capacity | inventory | price
  value          numeric not null
);
select create_hypertable('market_metrics', by_range('ts'), if_not_exists => true);
