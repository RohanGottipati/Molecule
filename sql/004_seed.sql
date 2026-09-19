-- Synthetic Canadian kit marketplace. Insert-only seed; reset restores explicit baselines.
do $$
begin
  if exists(select 1 from merchants where merchant_id in
    ('base-goods','stitch-works','thread-forge','needle-north','laser-lab','snack-box','pack-ship')
    and demo_tag is distinct from 'MOLECULE_DEMO') then
    raise exception 'Demo merchant ID collides with a non-demo merchant';
  end if;
end $$;
insert into merchants(merchant_id,name,status,demo_tag) values
  ('base-goods','Base Goods','online','MOLECULE_DEMO'),
  ('stitch-works','StitchWorks','online','MOLECULE_DEMO'),
  ('thread-forge','Thread Forge','online','MOLECULE_DEMO'),
  ('needle-north','Needle North','online','MOLECULE_DEMO'),
  ('laser-lab','Laser Lab','online','MOLECULE_DEMO'),
  ('snack-box','Snack Box','online','MOLECULE_DEMO'),
  ('pack-ship','Pack & Ship','online','MOLECULE_DEMO')
on conflict(merchant_id) do nothing;

with catalog(id,merchant,kind,name,price,setup,hours,capacity,period,accepts,produces) as (values
  ('cap-base-hoodie','base-goods','SUPPLY','Premium black cotton hoodie',12,0,8,1000,'week','[]',
   '[{"kind":"garment","name":"hoodie","attributes":{"product":"hoodie","material":"cotton","color":"black","quality":"premium"}}]'),
  ('cap-base-bottle','base-goods','SUPPLY','Black stainless steel bottle',5,0,8,1000,'week','[]',
   '[{"kind":"bottle","name":"bottle","attributes":{"product":"bottle","material":"stainless steel","color":"black","quality":"premium"}}]'),
  ('cap-snacks','snack-box','SUPPLY','Vegan snack selection',3,0,6,1000,'week','[]',
   '[{"kind":"food","name":"snacks","attributes":{"product":"snacks","diet":"vegan","material":"plant-based","quality":"premium"}}]'),
  ('cap-stitch-embroidery','stitch-works','TRANSFORM','Logo embroidery',4.2,25,24,20,'day',
   '[{"kind":"garment","name":"hoodie","attributes":{"product":"hoodie","material":"cotton","color":"black"}}]',
   '[{"kind":"garment","name":"embroidered_hoodie","attributes":{"product":"hoodie","material":"cotton","color":"black","decoration":"embroidery","personalization":"logo","technique":"embroidery"}}]'),
  ('cap-thread-embroidery','thread-forge','TRANSFORM','Logo embroidery',4.5,25,16,400,'day',
   '[{"kind":"garment","name":"hoodie","attributes":{"product":"hoodie","material":"cotton","color":"black"}}]',
   '[{"kind":"garment","name":"embroidered_hoodie","attributes":{"product":"hoodie","material":"cotton","color":"black","decoration":"embroidery","personalization":"logo","technique":"embroidery"}}]'),
  ('cap-needle-embroidery','needle-north','TRANSFORM','Logo embroidery backup',5.1,25,20,300,'day',
   '[{"kind":"garment","name":"hoodie","attributes":{"product":"hoodie","material":"cotton","color":"black"}}]',
   '[{"kind":"garment","name":"embroidered_hoodie","attributes":{"product":"hoodie","material":"cotton","color":"black","decoration":"embroidery","personalization":"logo","technique":"embroidery"}}]'),
  ('cap-laser-engraving','laser-lab','TRANSFORM','Individual name engraving',3.2,30,12,400,'day',
   '[{"kind":"bottle","name":"bottle","attributes":{"product":"bottle","material":"stainless steel","color":"black"}}]',
   '[{"kind":"bottle","name":"engraved_bottle","attributes":{"product":"bottle","material":"stainless steel","color":"black","decoration":"engraving","personalization":"individual names","technique":"engraving"}}]'),
  ('cap-pack-assembly','pack-ship','ASSEMBLE','Individual kit packaging',2,0,6,600,'day',
   '[{"kind":"garment","name":"embroidered_hoodie","attributes":{"product":"hoodie","decoration":"embroidery"}},{"kind":"bottle","name":"engraved_bottle","attributes":{"product":"bottle","decoration":"engraving"}},{"kind":"food","name":"snacks","attributes":{"product":"snacks","diet":"vegan"}}]',
   '[{"kind":"package","name":"kit","attributes":{"product":"kit","packaging":"individual","material":"recycled cardboard","color":"black","quality":"premium"}}]'),
  ('cap-pack-fulfillment','pack-ship','FULFILL','Canadian kit fulfillment',2,0,12,600,'day',
   '[{"kind":"package","name":"kit","attributes":{"product":"kit","packaging":"individual"}}]',
   '[{"kind":"package","name":"delivered_kit","attributes":{"product":"kit","packaging":"individual","material":"recycled cardboard","color":"black","destination":"Canada"}}]')
)
insert into capabilities(capability_id,merchant_id,kind,name,description,capability_json)
select id,merchant,kind,name,'Synthetic demo: '||name,
  jsonb_build_object('capabilityId',id,'merchantId',merchant,'kind',kind,'name',name,
    'description','Synthetic demo: '||name,'accepts',accepts::jsonb,'produces',produces::jsonb,
    'quantity',jsonb_build_object('min',1,'max',1000,'unit','unit'),
    'pricing',jsonb_build_object('currency','CAD','unitPrice',price,'setupFee',setup),
    'leadTime',jsonb_build_object('min',hours,'max',hours,'unit','hours'),
    'capacity',jsonb_build_object('available',capacity,'maximum',capacity,'period',period,'asOf','2026-09-19T00:00:00.000Z'),
    'hardRules','[]'::jsonb,'softRules','[]'::jsonb,
    'sourceClaimIds',jsonb_build_array('demo:'||id||':price','demo:'||id||':capacity','demo:'||id||':lead'))
from catalog on conflict(capability_id) do nothing;

insert into demo_capability_baselines select capability_id,capability_json from capabilities
  where merchant_id in(select merchant_id from merchants where demo_tag='MOLECULE_DEMO')
on conflict(capability_id) do nothing;

update capabilities c set capability_json=jsonb_set(c.capability_json,'{produces}',
  (select jsonb_agg(case when port->'attributes'->>'technique' in ('embroidery','engraving')
    then jsonb_set(port,'{attributes,operation}',port->'attributes'->'technique') else port end)
   from jsonb_array_elements(c.capability_json->'produces') port))
where c.merchant_id in(select merchant_id from merchants where demo_tag='MOLECULE_DEMO')
  and not exists(select 1 from jsonb_array_elements(c.capability_json->'produces') p
    where p->'attributes' ? 'operation');
update demo_capability_baselines b set capability_json=c.capability_json
  from capabilities c where c.capability_id=b.capability_id
  and not exists(select 1 from jsonb_array_elements(b.capability_json->'produces') p
    where p->'attributes' ? 'operation');

insert into canonical_claims(claim_id,merchant_id,field,normalized_value,source_kind,source_reference,
  observed_at,ingested_at,source_authority,extraction_confidence,evidence_text)
select 'demo:'||c.capability_id||':inventory',c.merchant_id,'inventory.'||c.capability_id,
  c.capability_json #> '{capacity,available}','api','demo:catalog:'||c.capability_id,
  '2026-09-19T00:00:00Z','2026-09-19T00:00:00Z',0.7,1,'Synthetic inventory baseline'
from capabilities c where c.kind='SUPPLY'
  and c.merchant_id in(select merchant_id from merchants where demo_tag='MOLECULE_DEMO')
on conflict(claim_id) do nothing;

insert into canonical_claims(claim_id,merchant_id,field,normalized_value,source_kind,source_reference,
  source_checksum,observed_at,ingested_at,source_authority,extraction_confidence,evidence_text)
select 'demo:'||c.capability_id||':'||v.suffix,c.merchant_id,c.capability_id||'.'||v.field,v.value,
  'api','demo:catalog:'||c.capability_id,encode(digest(c.capability_json::text,'sha256'),'hex'),
  '2026-09-19T00:00:00Z','2026-09-19T00:00:00Z',0.7,1,'Synthetic verified operational catalog'
from capabilities c cross join lateral(values
  ('price','price',c.capability_json #> '{pricing,unitPrice}'),
  ('capacity','capacity',c.capability_json #> '{capacity,available}'),
  ('lead','lead_time_hours',c.capability_json #> '{leadTime,max}')
) v(suffix,field,value)
where c.merchant_id in(select merchant_id from merchants where demo_tag='MOLECULE_DEMO')
on conflict(claim_id) do nothing;

insert into canonical_claims(claim_id,merchant_id,field,normalized_value,normalized_unit,source_kind,
  source_reference,observed_at,ingested_at,source_authority,extraction_confidence,resolution_status,evidence_text)
values
('demo:stitch:web','stitch-works','capacity_per_day','100','units','shopify','demo:web:stitch-works',
 '2026-08-20T00:00:00Z','2026-09-19T00:00:00Z',0.5,0.6,'active','Synthetic website: up to 100/day'),
('demo:stitch:document','stitch-works','capacity_per_day','50','units','document','demo:document:stitch-works',
 '2026-09-09T00:00:00Z','2026-09-19T00:00:00Z',0.6,0.7,'active','Synthetic document: 50/day'),
('demo:stitch:outage','stitch-works','capacity_per_day','20','units','note','demo:note:machine-2-down',
 '2026-09-18T00:00:00Z','2026-09-19T00:00:00Z',0.99,1,'active','Synthetic fresh outage note: machine #2 down; 20/day'),
('demo:stitch:invalid','stitch-works','capacity_per_day','"about a lot, ask us"',null,'csv','demo:csv:row-14',
 '2026-09-18T00:00:00Z','2026-09-19T00:00:00Z',0.3,0.2,'quarantined','Malformed capacity; never used')
on conflict(claim_id) do nothing;

insert into raw_artifacts(artifact_id,merchant_id,source_kind,source_reference,checksum,raw_content)
select claim_id,merchant_id,source_kind,source_reference,
  encode(digest(jsonb_build_object('rawValue',normalized_value,'evidenceText',evidence_text)::text,'sha256'),'hex'),
  jsonb_build_object('rawValue',normalized_value,'evidenceText',evidence_text)
from canonical_claims where claim_id like 'demo:%'
on conflict(artifact_id) do nothing;
update canonical_claims c set source_checksum=a.checksum from raw_artifacts a
  where a.artifact_id=c.claim_id and c.source_checksum is distinct from a.checksum;
insert into quarantined_claims values
  ('demo:stitch:invalid','demo:stitch:invalid','Non-numeric capacity in CSV row','2026-09-19T00:00:00Z')
on conflict(quarantine_id) do nothing;

insert into merchant_policies(policy_id,merchant_id,policy_text,source)
select 'demo:policy:'||merchant_id,merchant_id,
  case when merchant_id='stitch-works' then 'Synthetic: no rush jobs over 40 units while machine #2 is down.'
  when merchant_id='laser-lab' then 'Synthetic: each bottle requires an approved recipient-name list; no guessed names.'
  when merchant_id='snack-box' then 'Synthetic: vegan assortment; allergen list must be reviewed before approval.'
  when merchant_id='pack-ship' then 'Synthetic: each kit is individually packaged in black recycled cardboard; Canadian shipping only.'
  else 'Synthetic: CAD pricing; logo and size breakdown require customer approval; no leather or polyester.' end,
  'demo:policy' from merchants where demo_tag='MOLECULE_DEMO'
on conflict(policy_id) do nothing;
insert into merchant_documents(document_id,merchant_id,kind,source_uri,name,status)
select 'demo:document:'||merchant_id,merchant_id,'catalog','demo:catalog:'||merchant_id,
  name||' synthetic operating catalog','available' from merchants where demo_tag='MOLECULE_DEMO'
on conflict(document_id) do nothing;

insert into fulfillment_samples(ts,merchant_id,capability_id,promised_hours,actual_hours,success)
select '2026-06-01T00:00:00Z'::timestamptz + n * interval '1 day',c.merchant_id,c.capability_id,
  (c.capability_json #>> '{leadTime,max}')::numeric,
  (c.capability_json #>> '{leadTime,max}')::numeric +
    case when c.merchant_id='stitch-works' then n%10*12 else n%10 end,
  n%20!=0
from capabilities c cross join generate_series(1,100) n
where c.merchant_id in(select merchant_id from merchants where demo_tag='MOLECULE_DEMO')
on conflict(ts,merchant_id,capability_id) do nothing;

insert into molecule_events(event_id,trace_id,merchant_id,event_type,severity,source,ts,payload)
select (substr(md5('demo:seed:'||merchant_id),1,8)||'-'||substr(md5('demo:seed:'||merchant_id),9,4)||
  '-4'||substr(md5('demo:seed:'||merchant_id),14,3)||'-8'||substr(md5('demo:seed:'||merchant_id),18,3)||
  '-'||substr(md5('demo:seed:'||merchant_id),21,12)),
  'demo-seed',merchant_id,'reality.merchant.seeded','INFO','rox','2026-09-19T00:00:00Z',
  '{"synthetic":true,"source":"deterministic demo catalog"}'
from merchants where demo_tag='MOLECULE_DEMO' on conflict(event_id) do nothing;
