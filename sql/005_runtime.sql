alter table merchants add column if not exists status text not null default 'unknown'
  check(status in ('online','offline','unknown'));
alter table merchants add column if not exists demo_tag text;
alter table merchant_documents add column if not exists name text;
alter table merchant_documents add column if not exists status text not null default 'available';
alter table reservations add column if not exists ttl_seconds integer not null default 1800;
alter table reservations add column if not exists trace_id text;
alter table molecule_events drop constraint if exists molecule_events_source_check;
alter table molecule_events add constraint molecule_events_source_check
  check(source in ('orchestrator','openai','rox','backboard','tiger','shopify','solver','ui'));
alter table molecule_events add column if not exists cursor bigserial;
create unique index if not exists idx_events_cursor on molecule_events(cursor);

create table if not exists raw_artifacts (
  artifact_id text primary key,
  merchant_id text not null references merchants(merchant_id),
  source_kind text not null,
  source_reference text not null,
  checksum text not null,
  raw_content jsonb not null,
  received_at timestamptz not null default now()
);
create table if not exists quarantined_claims (
  quarantine_id text primary key,
  artifact_id text not null references raw_artifacts(artifact_id),
  reason text not null,
  created_at timestamptz not null default now()
);
create table if not exists canonical_resolutions (
  merchant_id text not null references merchants(merchant_id),
  field text not null,
  status text not null check(status in ('resolved','conflicted','unknown')),
  winning_claim_id text references canonical_claims(claim_id),
  value jsonb,
  explanation text not null,
  scores jsonb not null,
  updated_at timestamptz not null default now(),
  primary key(merchant_id,field)
);
create table if not exists demo_capability_baselines (
  capability_id text primary key references capabilities(capability_id),
  capability_json jsonb not null
);
create table if not exists demo_chaos_actions (
  action_key text primary key,
  merchant_id text not null references merchants(merchant_id),
  scenario text not null,
  trace_id text not null,
  request_json jsonb not null,
  created_at timestamptz not null default now(),
  reverted_at timestamptz
);

create or replace function molecule_event_cursor() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(73481203);
  new.cursor := nextval(pg_get_serial_sequence('molecule_events','cursor'));
  return new;
end $$;
drop trigger if exists molecule_event_cursor on molecule_events;
create trigger molecule_event_cursor before insert on molecule_events
  for each row execute function molecule_event_cursor();

create or replace function molecule_event_publish() returns trigger language plpgsql as $$
begin
  insert into network_events(ts,event_id,trace_id,order_id,plan_id,merchant_id,event_type,source,severity,numeric_value,unit,payload)
    values(new.ts,new.event_id,new.trace_id,new.order_id,new.plan_id,new.merchant_id,new.event_type,new.source,new.severity,
      case when jsonb_typeof(new.payload->'value')='number' then (new.payload->>'value')::numeric end,
      new.payload->>'unit',new.payload)
    on conflict(ts,event_id) do nothing;
  if new.event_type='reality.claim.resolved' and new.merchant_id is not null
      and jsonb_typeof(new.payload->'value')='number'
      and (new.payload->>'field' in ('capacity','capacity_per_day','inventory')
        or new.payload->>'field' ~ '\.(capacity|capacity_per_day|inventory)$') then
    insert into market_metrics(ts,merchant_id,capability_id,metric,value)
      values(new.ts,new.merchant_id,
        case when position('.' in new.payload->>'field')>0 then split_part(new.payload->>'field','.',1) end,
        'capacity',(new.payload->>'value')::numeric);
  end if;
  perform pg_notify('molecule_events',new.cursor::text);
  return new;
end $$;
drop trigger if exists molecule_event_publish on molecule_events;
create trigger molecule_event_publish after insert on molecule_events
  for each row execute function molecule_event_publish();
insert into network_events(ts,event_id,trace_id,order_id,plan_id,merchant_id,event_type,source,severity,payload)
  select ts,event_id,trace_id,order_id,plan_id,merchant_id,event_type,source,severity,payload from molecule_events
  on conflict(ts,event_id) do nothing;
