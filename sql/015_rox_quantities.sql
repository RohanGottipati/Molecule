-- 015_rox_quantities.sql
-- Canonical quantities mined from the free-text `quantity_label` on 61k real
-- Open Food Facts products ("6 oz (170 g)", "1,5L", "10x 0.8 oz", "1 dozen").
--
-- The point of the separate table is provenance: every value records whether a
-- mined rule produced it or a model was asked directly, and which rule it was.
-- Additive.

create table if not exists bulk_product_quantities (
  sku          text primary key references bulk_products(sku) on delete cascade,
  raw_label    text not null,
  grams        numeric,
  millilitres  numeric,
  count_units  numeric,          -- "6 rolls", "300 tablets": countable, not weighable
  method       text not null check (method in ('rule', 'model', 'unparseable')),
  rule_id      text references rox_rules(rule_id),
  confidence   numeric check (confidence between 0 and 1),
  created_at   timestamptz not null default now()
);
create index if not exists idx_bulk_quantities_method on bulk_product_quantities(method);
create index if not exists idx_bulk_quantities_rule on bulk_product_quantities(rule_id);

-- The measurement set: per-label judgements used to score mined rules. Held
-- apart from the rules themselves so a rule can never be scored on the sample
-- it was mined from.
create table if not exists rox_rule_holdout (
  raw_label    text primary key,
  grams        numeric,
  millilitres  numeric,
  count_units  numeric,
  unparseable  boolean not null default false,
  labelled_by  text not null,
  created_at   timestamptz not null default now()
);

alter table rox_rules add column if not exists domain_detail jsonb not null default '{}'::jsonb;
