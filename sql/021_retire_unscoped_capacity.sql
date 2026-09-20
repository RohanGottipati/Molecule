-- Merchant-wide Shopify inventory claims aggregate unrelated resources and can
-- never certify executable capacity. Preserve them as evidence, but remove
-- them from resolution and record why the retirement happened.
alter table canonical_claims
  add column if not exists resolution_note text;

insert into molecule_events(
  event_id,trace_id,merchant_id,event_type,severity,source,ts,payload
)
select
  'migration:021:unscoped-capacity:' || merchant_id,
  'migration-021-unscoped-capacity',
  merchant_id,
  'reality.claims.superseded',
  'WARN',
  'rox',
  now(),
  jsonb_build_object(
    'field', 'capacity_per_day',
    'reason', 'retired_unscoped_capacity_claim',
    'claimCount', count(*)
  )
from canonical_claims
where field = 'capacity_per_day'
  and resolution_status <> 'superseded'
group by merchant_id
on conflict(event_id) do nothing;

update canonical_claims
set resolution_status = 'superseded',
    resolution_note = 'Migration 021: retired unscoped capacity claim; use resource.<resourceId>.(inventory|capacity)'
where field = 'capacity_per_day'
  and resolution_status <> 'superseded';

update claim_conflicts
set status = 'resolved', resolved_at = coalesce(resolved_at, now())
where field = 'capacity_per_day' and status = 'conflicted';

delete from canonical_resolutions where field = 'capacity_per_day';
