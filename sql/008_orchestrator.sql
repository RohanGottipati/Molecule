create table if not exists order_sessions (
  order_id text primary key,
  revision integer not null,
  session_json jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists orchestrator_actions (
  action_key text primary key,
  receipt jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists order_contexts (
  context_id text primary key,
  order_id text not null references order_sessions(order_id),
  context_json jsonb not null,
  content bytea,
  created_at timestamptz not null default now()
);
create index if not exists order_contexts_order on order_contexts(order_id);

update capabilities c set capability_json=jsonb_set(c.capability_json,'{produces}',
  (select jsonb_agg(case when port->'attributes'->>'technique' in ('embroidery','engraving')
    then jsonb_set(port,'{attributes,operation}',port->'attributes'->'technique') else port end)
   from jsonb_array_elements(c.capability_json->'produces') port))
where c.merchant_id in(select merchant_id from merchants where demo_tag='MOLECULE_DEMO');
update demo_capability_baselines b set capability_json=c.capability_json
  from capabilities c where c.capability_id=b.capability_id;
insert into canonical_claims(claim_id,merchant_id,field,normalized_value,source_kind,source_reference,
  observed_at,ingested_at,source_authority,extraction_confidence,evidence_text)
select 'demo:'||c.capability_id||':inventory',c.merchant_id,'inventory.'||c.capability_id,
  c.capability_json #> '{capacity,available}','api','demo:catalog:'||c.capability_id,
  '2026-09-19T00:00:00Z','2026-09-19T00:00:00Z',0.7,1,'Synthetic inventory baseline'
from capabilities c where c.kind='SUPPLY'
  and c.merchant_id in(select merchant_id from merchants where demo_tag='MOLECULE_DEMO')
on conflict(claim_id) do nothing;
