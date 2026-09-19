-- 014_rox_links.sql
-- Entity resolution results live on the extraction they belong to: which
-- merchant and capability a candidate fact was finally attributed to, how that
-- attribution was made, and how sure it was. Additive.

alter table rox_extractions add column if not exists resolved_merchant_id text references merchants(merchant_id);
alter table rox_extractions add column if not exists resolved_capability_id text;
alter table rox_extractions add column if not exists link_method text;
alter table rox_extractions add column if not exists link_score numeric;
alter table rox_extractions add column if not exists resolved_field text;
alter table rox_extractions add column if not exists normalized_value jsonb;
alter table rox_extractions add column if not exists normalized_unit text;
create index if not exists idx_rox_extractions_resolved on rox_extractions(resolved_merchant_id, resolved_field);

-- Cross-source agreement is what turns a lone claim into a trusted one, so the
-- dashboard needs the disagreement view as a first-class object.
create or replace view rox_field_disagreement as
  select merchant_id,
         field,
         count(*) as claims,
         count(distinct normalized_value::text) as distinct_values,
         jsonb_agg(jsonb_build_object(
           'value', normalized_value, 'unit', normalized_unit, 'source', source_kind,
           'reference', source_reference, 'authority', source_authority,
           'confidence', extraction_confidence, 'observedAt', observed_at,
           'status', resolution_status) order by observed_at desc nulls last) as claims_detail
  from canonical_claims
  where resolution_status in ('active', 'conflicted')
  group by 1, 2;
