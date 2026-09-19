do $$
declare extension_name text;
begin
  foreach extension_name in array array['timescaledb_toolkit','vector'] loop
    begin
      execute format('create extension if not exists %I',extension_name);
      insert into database_features values(extension_name,true,'Extension installed')
        on conflict(name) do update set available=true,detail=excluded.detail;
    exception when others then
      insert into database_features values(extension_name,false,SQLERRM)
        on conflict(name) do update set available=false,detail=excluded.detail;
    end;
  end loop;
end $$;

create or replace view merchant_risk as
select merchant_id, capability_id,
  percentile_cont(0.5) within group(order by actual_hours) as p50_hours,
  percentile_cont(0.95) within group(order by actual_hours) as p95_hours,
  percentile_cont(0.99) within group(order by actual_hours) as p99_hours,
  count(*) as sample_count
from fulfillment_samples where actual_hours >= 0
group by merchant_id,capability_id;

do $$
begin
  if exists(select 1 from pg_extension where extname='timescaledb') then
    execute 'create materialized view if not exists merchant_health_5m with(timescaledb.continuous,timescaledb.materialized_only=false) as
      select merchant_id,time_bucket(''5 minutes'',ts) as bucket,
      count(*) filter(where event_type=''merchant.quote.timeout'') as timeouts,
      count(*) filter(where event_type=''merchant.quote.received'') as quotes_received
      from network_events where merchant_id is not null group by merchant_id,bucket with no data';
    execute 'create materialized view if not exists capability_capacity_1m with(timescaledb.continuous,timescaledb.materialized_only=false) as
      select merchant_id,capability_id,time_bucket(''1 minute'',ts) as bucket,avg(value) as avg_capacity
      from market_metrics where metric=''capacity'' group by merchant_id,capability_id,bucket with no data';
    if exists(select 1 from pg_extension where extname='timescaledb_toolkit') then
      execute 'create materialized view if not exists lead_time_hourly with(timescaledb.continuous,timescaledb.materialized_only=false) as
        select merchant_id,capability_id,time_bucket(''1 hour'',ts) as bucket,
        percentile_agg(actual_hours::double precision) as pct_agg,count(*) as sample_count
        from fulfillment_samples group by merchant_id,capability_id,bucket with no data';
      perform add_continuous_aggregate_policy('lead_time_hourly', start_offset => interval '120 days',
        end_offset => interval '1 hour', schedule_interval => interval '1 hour', if_not_exists => true);
    end if;
    perform add_continuous_aggregate_policy('merchant_health_5m', start_offset => interval '120 days',
      end_offset => interval '5 minutes', schedule_interval => interval '5 minutes', if_not_exists => true);
    perform add_continuous_aggregate_policy('capability_capacity_1m', start_offset => interval '120 days',
      end_offset => interval '1 minute', schedule_interval => interval '5 minutes', if_not_exists => true);
  else
    execute 'create or replace view merchant_health_5m as
      select merchant_id,date_bin(''5 minutes'',ts,''2000-01-01''::timestamptz) as bucket,
      count(*) filter(where event_type=''merchant.quote.timeout'') as timeouts,
      count(*) filter(where event_type=''merchant.quote.received'') as quotes_received
      from network_events where merchant_id is not null group by merchant_id,bucket';
    execute 'create or replace view capability_capacity_1m as
      select merchant_id,capability_id,date_trunc(''minute'',ts) as bucket,avg(value) as avg_capacity
      from market_metrics where metric=''capacity'' group by merchant_id,capability_id,bucket';
  end if;
  if not exists(select 1 from pg_extension where extname='timescaledb')
      or not exists(select 1 from pg_extension where extname='timescaledb_toolkit') then
    execute 'create or replace view lead_time_hourly as
      select merchant_id,capability_id,date_trunc(''hour'',ts) as bucket,
      percentile_cont(0.5) within group(order by actual_hours) as p50_hours,
      percentile_cont(0.95) within group(order by actual_hours) as p95_hours,
      percentile_cont(0.99) within group(order by actual_hours) as p99_hours,
      count(*) as sample_count from fulfillment_samples group by merchant_id,capability_id,bucket';
  end if;
  if exists(select 1 from pg_extension where extname='vector') then
    execute 'create table if not exists capability_embeddings(
      capability_id text primary key references capabilities(capability_id) on delete cascade,
      embedding vector(1536) not null,model text not null,updated_at timestamptz not null default now())';
    execute 'create index if not exists idx_capability_embeddings_hnsw
      on capability_embeddings using hnsw(embedding vector_cosine_ops)';
  end if;
end $$;
