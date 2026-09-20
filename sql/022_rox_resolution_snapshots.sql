-- Immutable, run-scoped resolver evidence. Historical evaluation must never
-- infer a past decision from the mutable canonical_resolutions projection.
create table if not exists rox_resolution_snapshots (
  run_id            text not null references rox_ingest_runs(run_id) on delete cascade,
  merchant_id       text not null references merchants(merchant_id) on delete cascade,
  field             text not null,
  status            text not null check (status in ('resolved','conflicted','unknown')),
  winning_claim_id  text references canonical_claims(claim_id),
  value             jsonb,
  normalized_unit   text,
  explanation       text not null,
  scores            jsonb not null default '[]'::jsonb,
  claim_ids         text[] not null default '{}',
  resolved_at       timestamptz not null,
  primary key (run_id, merchant_id, field)
);

create index if not exists idx_rox_resolution_snapshots_run_status
  on rox_resolution_snapshots(run_id,status);
