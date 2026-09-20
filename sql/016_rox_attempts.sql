-- 016_rox_attempts.sql
-- Which artifacts a run has already looked at.
--
-- Roughly forty percent of the corpus (support tickets, customer briefs)
-- correctly yields no facts at all, so "has an extraction row" is not the same
-- as "has been processed". Without this, resuming an interrupted run pays the
-- model again for every document that was right to say nothing. Additive.

create table if not exists rox_artifact_attempts (
  run_id       text not null references rox_ingest_runs(run_id) on delete cascade,
  artifact_id  text not null references raw_artifacts(artifact_id) on delete cascade,
  candidates   integer not null default 0,
  injection    boolean not null default false,
  attempted_at timestamptz not null default now(),
  primary key (run_id, artifact_id)
);
create index if not exists idx_rox_attempts_run on rox_artifact_attempts(run_id);
