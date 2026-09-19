-- 004_seed.sql
-- Deterministic demo merchant world: one clean path, one forced conflict
-- (CustomizeCo's capacity), and one backup merchant for chaos recovery.
-- Tag: MOLECULE_DEMO. Re-runnable: clears and re-inserts by fixed IDs.

delete from canonical_claims where merchant_id in
  ('m-basegoods', 'm-customizeco', 'm-packship', 'm-customizeco2');
delete from capabilities where merchant_id in
  ('m-basegoods', 'm-customizeco', 'm-packship', 'm-customizeco2');
delete from merchants where merchant_id in
  ('m-basegoods', 'm-customizeco', 'm-packship', 'm-customizeco2');

insert into merchants (merchant_id, name) values
  ('m-basegoods',    'BaseGoods'),
  ('m-customizeco',  'CustomizeCo'),
  ('m-packship',     'PackShip'),
  ('m-customizeco2', 'CustomizeCo2 (backup, pricier/slower)');

insert into capabilities (capability_id, merchant_id, kind, name, description, capability_json) values
(
  'cap-basegoods-hoodie', 'm-basegoods', 'SUPPLY', 'Black cotton hoodie',
  'Black cotton hoodies, sizes S-XL',
  '{
    "capabilityId": "cap-basegoods-hoodie",
    "merchantId": "m-basegoods",
    "kind": "SUPPLY",
    "name": "Black cotton hoodie",
    "description": "Black cotton hoodies, sizes S-XL",
    "accepts": [],
    "produces": [{"kind": "garment", "name": "cotton_hoodie", "attributes": {"color": "black", "material": "cotton"}}],
    "quantity": {"min": 1, "max": 500, "unit": "unit"},
    "pricing": {"currency": "CAD", "unitPrice": 18, "setupFee": 0},
    "leadTime": {"min": 4, "max": 24, "unit": "hours"},
    "capacity": {"available": 500, "maximum": 500, "period": "week"},
    "hardRules": [],
    "softRules": [],
    "sourceClaimIds": []
  }'::jsonb
),
(
  'cap-customizeco-embroidery', 'm-customizeco', 'TRANSFORM', 'Logo embroidery',
  'Logo embroidery on cotton garments',
  '{
    "capabilityId": "cap-customizeco-embroidery",
    "merchantId": "m-customizeco",
    "kind": "TRANSFORM",
    "name": "Logo embroidery",
    "description": "Logo embroidery on cotton garments",
    "accepts": [{"kind": "garment", "name": "cotton_hoodie", "attributes": {"material": "cotton"}}],
    "produces": [{"kind": "garment", "name": "embroidered_hoodie", "attributes": {}}],
    "quantity": {"min": 1, "max": 100, "unit": "unit"},
    "pricing": {"currency": "CAD", "unitPrice": 6, "setupFee": 25},
    "leadTime": {"min": 8, "max": 48, "unit": "hours"},
    "capacity": {"available": 20, "maximum": 100, "period": "day"},
    "hardRules": [],
    "softRules": [],
    "sourceClaimIds": ["claim-cust-capacity-note"]
  }'::jsonb
),
(
  'cap-packship-assembly', 'm-packship', 'FULFILL', 'Assembly and packaging',
  'Final assembly, packaging, and fulfillment',
  '{
    "capabilityId": "cap-packship-assembly",
    "merchantId": "m-packship",
    "kind": "FULFILL",
    "name": "Assembly and packaging",
    "description": "Final assembly, packaging, and fulfillment",
    "accepts": [{"kind": "garment", "name": "embroidered_hoodie", "attributes": {}}],
    "produces": [{"kind": "package", "name": "shipped_order", "attributes": {}}],
    "quantity": {"min": 1, "max": 500, "unit": "unit"},
    "pricing": {"currency": "CAD", "unitPrice": 3, "setupFee": 10},
    "leadTime": {"min": 4, "max": 24, "unit": "hours"},
    "capacity": {"available": 500, "maximum": 500, "period": "week"},
    "hardRules": [],
    "softRules": [],
    "sourceClaimIds": []
  }'::jsonb
),
(
  'cap-customizeco2-embroidery', 'm-customizeco2', 'TRANSFORM', 'Logo embroidery (backup)',
  'Backup embroidery capacity: pricier and slower than CustomizeCo',
  '{
    "capabilityId": "cap-customizeco2-embroidery",
    "merchantId": "m-customizeco2",
    "kind": "TRANSFORM",
    "name": "Logo embroidery (backup)",
    "description": "Backup embroidery capacity: pricier and slower than CustomizeCo",
    "accepts": [{"kind": "garment", "name": "cotton_hoodie", "attributes": {"material": "cotton"}}],
    "produces": [{"kind": "garment", "name": "embroidered_hoodie", "attributes": {}}],
    "quantity": {"min": 1, "max": 60, "unit": "unit"},
    "pricing": {"currency": "CAD", "unitPrice": 9, "setupFee": 25},
    "leadTime": {"min": 24, "max": 72, "unit": "hours"},
    "capacity": {"available": 60, "maximum": 60, "period": "day"},
    "hardRules": [],
    "softRules": [],
    "sourceClaimIds": []
  }'::jsonb
);

-- The forced conflict: three sources disagree about CustomizeCo's capacity.
-- Highest authority * recency * confidence should win: the fresh 20/day note.
insert into canonical_claims
  (claim_id, merchant_id, field, normalized_value, normalized_unit,
   source_kind, source_reference, observed_at, source_authority,
   extraction_confidence, resolution_status, evidence_text)
values
(
  'claim-cust-capacity-website', 'm-customizeco', 'capacity_per_day',
  '100'::jsonb, 'units', 'shopify', 'shopify:product-description',
  now() - interval '30 days', 0.5, 0.6, 'active',
  'Shopify product page lists "up to 100 units/day" in marketing copy'
),
(
  'claim-cust-capacity-pdf', 'm-customizeco', 'capacity_per_day',
  '50'::jsonb, 'units', 'document', 'doc:pricing-sheet.pdf',
  now() - interval '10 days', 0.6, 0.7, 'active',
  'Pricing sheet PDF states standard capacity of 50 units/day'
),
(
  'claim-cust-capacity-note', 'm-customizeco', 'capacity_per_day',
  '20'::jsonb, 'units', 'note', 'note:machine-2-down',
  now() - interval '1 day', 0.9, 0.95, 'active',
  'Merchant-submitted note: "machine #2 is down, capacity is 20/day until fixed"'
);

-- one intentionally malformed row for the quarantine path (T5 acceptance
-- criteria: "malformed source is quarantined, not silently accepted")
insert into canonical_claims
  (claim_id, merchant_id, field, normalized_value, normalized_unit,
   source_kind, source_reference, observed_at, source_authority,
   extraction_confidence, resolution_status, evidence_text)
values
(
  'claim-cust-capacity-malformed', 'm-customizeco', 'capacity_per_day',
  '"about a lot, ask us"'::jsonb, null, 'csv', 'csv:row-14',
  now() - interval '2 days', 0.3, 0.2, 'quarantined',
  'Non-numeric value in CSV capacity column, could not normalize'
);
