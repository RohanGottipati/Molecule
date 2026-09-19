create table if not exists database_features (
  name text primary key,
  available boolean not null,
  detail text not null
);

do $$
begin
  begin
    create extension if not exists timescaledb;
    insert into database_features values ('timescaledb', true, 'Extension installed')
      on conflict (name) do update set available = true, detail = excluded.detail;
  exception when others then
    insert into database_features values ('timescaledb', false, SQLERRM)
      on conflict (name) do update set available = false, detail = excluded.detail;
  end;
end $$;

create table if not exists network_events (
  ts timestamptz not null,
  event_id text not null,
  trace_id text not null,
  order_id text,
  plan_id text,
  merchant_id text,
  event_type text not null,
  source text,
  severity text,
  numeric_value numeric,
  unit text,
  payload jsonb
);
create unique index if not exists idx_network_event_identity on network_events(ts,event_id);
create index if not exists idx_network_events_order on network_events(order_id,ts desc);
create index if not exists idx_network_events_merchant on network_events(merchant_id,ts desc);
create index if not exists idx_network_events_type on network_events(event_type,ts desc);

create table if not exists fulfillment_samples (
  ts timestamptz not null,
  merchant_id text not null,
  capability_id text not null,
  promised_hours numeric,
  actual_hours numeric,
  success boolean not null
);
create unique index if not exists idx_fulfillment_identity on fulfillment_samples(ts,merchant_id,capability_id);
create index if not exists idx_fulfillment_merchant_cap on fulfillment_samples(merchant_id,capability_id,ts desc);
create table if not exists market_metrics (
  ts timestamptz not null,
  merchant_id text not null,
  capability_id text,
  metric text not null,
  value numeric not null
);

do $$
begin
  if exists(select 1 from pg_extension where extname = 'timescaledb') then
    perform create_hypertable('network_events','ts',if_not_exists => true,migrate_data => true);
    perform create_hypertable('fulfillment_samples','ts',if_not_exists => true,migrate_data => true);
    perform create_hypertable('market_metrics','ts',if_not_exists => true,migrate_data => true);
  end if;
end $$;
