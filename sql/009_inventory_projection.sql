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
        or new.payload->>'field' ~ '\.(capacity|capacity_per_day|inventory)$'
        or new.payload->>'field' like 'inventory.%') then
    insert into market_metrics(ts,merchant_id,capability_id,metric,value)
      values(new.ts,new.merchant_id,
        case
          when new.payload->>'field' like 'inventory.%' then substring(new.payload->>'field' from 11)
          when position('.' in new.payload->>'field')>0 then
            regexp_replace(new.payload->>'field','\.(capacity|capacity_per_day|inventory)$','')
        end,
        'capacity',(new.payload->>'value')::numeric);
  end if;
  perform pg_notify('molecule_events',new.cursor::text);
  return new;
end $$;

insert into market_metrics(ts,merchant_id,capability_id,metric,value)
select e.ts,e.merchant_id,substring(e.payload->>'field' from 11),'capacity',(e.payload->>'value')::numeric
from molecule_events e
where e.event_type='reality.claim.resolved' and e.merchant_id is not null
  and jsonb_typeof(e.payload->'value')='number' and e.payload->>'field' like 'inventory.%'
  and not exists (
    select 1 from market_metrics m where m.ts=e.ts and m.merchant_id=e.merchant_id
      and m.capability_id=substring(e.payload->>'field' from 11)
      and m.metric='capacity' and m.value=(e.payload->>'value')::numeric
  );
