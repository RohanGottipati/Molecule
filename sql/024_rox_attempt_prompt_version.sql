-- Make prompt migrations resumable even when a correct extraction returns no
-- candidates. Extraction rows cannot represent that case, so the completed
-- attempt records the prompt version that actually processed the artifact.

alter table rox_artifact_attempts
  add column if not exists prompt_version text;

create index if not exists idx_rox_attempts_artifact_prompt
  on rox_artifact_attempts(artifact_id,prompt_version)
  where prompt_version is not null;
