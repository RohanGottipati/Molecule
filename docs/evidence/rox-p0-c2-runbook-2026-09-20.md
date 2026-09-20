# ROX P0 C2 deployment runbook — 2026-09-20

This runbook closes C2 without rewriting historical evidence. It is deliberately
staged: extract first, inspect, then allow deterministic linking, normalization,
resolution, and scoring. The configured shared Tiger database was queried
read-only to produce the counts below; none of these deployment steps have been
run there yet.

## Pre-deployment state

| Check                                   | Observed value |
| --------------------------------------- | -------------: |
| `rox-extract-v3` extraction rows        |            724 |
| Distinct v3 artifacts                   |            360 |
| `rox-extract-v4` extraction rows        |              0 |
| Applied ROX migrations 021, 022 and 024 |              0 |
| Active unscoped operational claims      |              6 |
| Quarantined unscoped operational claims |              2 |
| Superseded unscoped operational claims  |              5 |
| Unscoped resolution rows (`resolved`)   |              6 |

The historical task text recorded nine conflicted resolutions. That is not the
current database state: the authoritative read on 2026-09-20 found six resolved
unscoped rows. Deployment evidence must use the table above as its before state
and record the actual after state, rather than repeating the older estimate.

## Why migration 024 is required

Extraction rows cannot prove that an artifact was processed: a correct model
response may contain zero candidates. Migration 024 adds `prompt_version` to
`rox_artifact_attempts`. Prompt migration selection therefore means:

1. the artifact has at least one historical extraction on the requested old
   prompt;
2. it has no completed attempt under the current prompt; and
3. it has not already completed in the current run.

This makes interruption recovery safe for both non-empty and empty v4 results.
Historical v3 rows remain immutable evidence.

## Authorized deployment sequence

Run from the repository root with the intended shared `DATABASE_URL` and
`OPENAI_API_KEY` loaded. Capture command output in the deployment record without
printing either credential.

```sh
# 1. Apply additive ROX migrations 021, 022 and 024 through the normal migrator.
pnpm --filter @molecule/db migrate

# 2. Preflight selection only. This creates dry-run bookkeeping but makes no
# provider call and writes no extraction, claim, or resolution.
cd rox_data
node --env-file=../.env --env-file=../.env.local pipeline/run.mjs \
  --stages=extract --batch=rox-full-s42 \
  --reextract-prompt=rox-extract-v3 --dry

# 3. Perform only the paid v4 extraction. The $5 ceiling is intentionally well
# above the historical run cost while still bounding an accidental expansion.
node --env-file=../.env --env-file=../.env.local pipeline/run.mjs \
  --stages=extract --batch=rox-full-s42 \
  --reextract-prompt=rox-extract-v3 --budget=5
```

Record the new run ID printed by step 3. Before promotion, verify that its
population is exactly the intended v3 artifact set and inspect its error,
evidence, injection, and cost counts. A successful empty response appears in
`rox_artifact_attempts` with `prompt_version = 'rox-extract-v4'` even though it
has no `rox_extractions` row.

```sql
select prompt_version, count(*) as attempts
from rox_artifact_attempts
where run_id = '<NEW_RUN_ID>'
group by prompt_version;

select prompt_version, outcome, count(*)
from rox_extractions
where run_id = '<NEW_RUN_ID>'
group by prompt_version, outcome
order by prompt_version, outcome;
```

If extraction is accepted, resume the same run and then freeze its scorecard:

```sh
node --env-file=../.env --env-file=../.env.local pipeline/run.mjs \
  --run=<NEW_RUN_ID> --stages=link,normalize,resolve \
  --batch=rox-full-s42

node --env-file=../.env --env-file=../.env.local pipeline/score.mjs \
  --run=<NEW_RUN_ID> \
  --output=../.molecule-data/order4/agent-v4-scored.json
```

## Acceptance evidence

C2 is complete only when the deployment record contains all of the following:

- migrations 021, 022 and 024 in `molecule_migrations`;
- 360 v4 attempt rows for the selected historical artifacts, unless the
  preflight proves a different current eligible count;
- zero extraction-stage errors, or an explicit retry/review record for each
  error;
- a frozen `rox-evaluation-v3` report with a verified snapshot hash;
- before/after unscoped-claim and resolution counts; and
- the v4 scorecard reported separately from the regex baseline and historical
  v3 scorecard.

Do not delete or update v3 extractions to make the v4 count look complete. A
failed or rejected v4 run remains audit evidence and must not be promoted by
running the downstream stages.
