# Order 1: database audit and scorer repair

Completed initial audit and scoring repair on 2026-09-19 Toronto / 2026-09-20 UTC.
No database rows were modified, migrations applied, provider messages sent or paid
model calls made. Aggregate audit evidence is committed alongside this report.
The historical benchmark was read and rescored locally; its stored scorecard was
not overwritten.

## Findings

| Check                         | Result                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Database health               | Default read-only **off**, not in recovery; about 1,364 MiB; no waiting locks or old transactions in the observed activity snapshot |
| Migration ledger              | All 21 non-seed SQL files through 020 recorded, with matching local SHA-256 checksums                                               |
| Sales provenance              | 1,032,918 original rows + 3,989,954 replay rows = 5,022,872; **79.4% replayed**                                                     |
| Products                      | 107,420 OFF + 4,721 UCI; OFF prices all explicitly synthetic                                                                        |
| Merchant provenance           | Eight demo-tagged, **219 unlabelled**; unlabelled does not mean real                                                                |
| Fulfillment history           | 1,200,000 rows; a fresh per-row provenance classification remains unavailable                                                       |
| Artifact duplicates           | Zero repeated `(checksum, source_reference)` signatures                                                                             |
| Claim observation duplicates  | Zero repeated merchant/field/source/checksum/time/value/unit signatures                                                             |
| Product-name collisions       | 9,854 groups, 36,700 excess rows sharing source and normalized title; different sizes/barcodes may legitimately share a title       |
| Sales duplicate candidates    | 53,973 groups, 57,972 excess rows with the same within-pass comparison signature; 11,792 excess rows in original `pass=0`           |
| ROX inputs                    | 1,226 batch artifacts: 1,152 parsed, 74 parse failures                                                                              |
| Completed extraction attempts | 1,144, including **784 with zero candidates**; these empty results were excluded by the old scorer                                  |

The sales signature is `(pass, invoice_ts, invoice, sku, quantity, unit_price,
customer_id, country)`. It intentionally excludes replay across different passes.
It also excludes source-row identity and description, so matches are review
candidates, not automatic deletion instructions. Repeated invoice lines can be
legitimate. There is still no defensible synthetic percentage for the whole DB.

The first unpartitioned sales scan hit PostgreSQL error `53200` (out of memory).
The completed version checks 125 month/pass partitions serially with 4 MB work
memory, hash aggregation disabled and no parallel workers. Every partition passed.
The date key is part of the duplicate signature, so this partitioning does not
split matching rows. No server settings were changed persistently.

Evidence: [aggregate audit](evidence/database-order1-audit.json).
These are time-specific observations, not continuous health monitoring.

## Scorer changes

- Extraction and regex baseline persist the selected artifact IDs in a
  `rox.evaluation.population` event before processing. Failures or budget stops
  cannot shrink the selected population. Selection is not a claim of completion.
- Baseline now records successful empty attempts, like model extraction.
- Each prediction can match at most one expected fact. Extra predictions reduce
  precision; missing facts reduce recall and downstream end-to-end attribution.
- Normalization compares with what the source stated, using explicit benchmark
  units and frozen demo conversion assumptions. Unknown units are unscorable,
  never silently treated as canonical. Null is not zero.
- Failed/skipped cases are not counted as successful injection defense or
  successful ambiguity handling. Successful empty attempts can be.
- The scorer checks supporting-text presence on claimed values. This is labelled
  `claimed_evidence_missing_pct`, not a universal hallucination detector.
- Global current resolutions are no longer used to grade a historical run.
  Outlier containment is **unavailable** until run-specific resolution evidence
  exists; the scorer does not invent a favorable result.
- Scoring reads a consistent, read-only transaction and saves the inputs, conversion
  settings, evaluator version, source hashes and Git revision in an exclusive-create
  local file. Replay validates the snapshot hash and needs no database connection.

Historical runs have no recorded selection manifest. Default scoring refuses to
call these attempted-run evaluations. Explicit `--legacy-batch` includes every
artifact in the batch and labels the result `legacy_full_batch_diagnostic`.
It can include unattempted inputs. Historical rows were mutable before capture;
a frozen snapshot represents their state at capture, not a reconstruction of
exactly what existed when the original run finished.

## Recomputed diagnostic

Same historical run `rox-20260919210029-d119c8a7`, frozen after this audit:

| Metric                                 | Revised full-batch diagnostic                                 |
| -------------------------------------- | ------------------------------------------------------------- |
| Population                             | 1,226 artifacts / 691 truth rows                              |
| Extraction precision / recall          | 86.0% / 94.4%                                                 |
| End-to-end attribution / normalization | 56.8% / 56.8%                                                 |
| Quarantine recall                      | 52.4%                                                         |
| Ambiguity held                         | 77.8%                                                         |
| Injection defense                      | 100% on 16 checked documents                                  |
| Claimed evidence missing               | 0% on 474 claimed candidates; does not prove semantic support |
| Outlier containment                    | Unavailable                                                   |

These differ from the old scorecard because matching, population, conversion and
possibly mutable input state differ. **Do not present the change as model improvement.**
No real-data accuracy claim follows from this synthetic benchmark.

Evidence: [sanitized scoring summary](evidence/rox-order1-score.json).
The full source-containing snapshot is gitignored under `.molecule-data/order1/`,
created with owner-only permissions. Keep it private if using real documents.

## Reproduce

From the repository root, with local dependencies installed:

```sh
# Fresh output paths are required; existing artifacts are never overwritten.
node --env-file=.env --env-file=.env.local rox_data/pipeline/audit.mjs --output=.molecule-data/order1/new-audit.json
node --env-file=.env --env-file=.env.local rox_data/pipeline/score.mjs --run=rox-20260919210029-d119c8a7 --legacy-batch --output=.molecule-data/order1/new-score.json
node rox_data/pipeline/score.mjs --snapshot=.molecule-data/order1/new-score.json --output=.molecule-data/order1/new-replay.json
node --test rox_data/tests/*.test.mjs
```

For future runs with a population event, omit `--legacy-batch`. Use separate run
IDs for agent and regex baseline. The command no longer writes `rox_scorecard` or
accepts a cosmetic `--variant` label; old dashboard rows remain legacy evidence.
The population covers selected extraction inputs; pipeline-wide parse failures
must also be reported from the batch audit, not mistaken for extraction attempts.

Validation: 17 evaluator and mocked pipeline tests passed, including provider
failure and empty baseline handling; frozen replay gave identical results/hash;
existing-output overwrite was rejected. Formatting, JavaScript syntax and
TypeScript checkJs with Node types and non-strict JS settings passed for affected
modules. This is not strict TypeScript coverage of the standalone ROX package.
The credentialed provider smoke was read-only Tiger access; no model behavior or
live Shopify action was exercised.

## Next decision

Order 1 establishes an honest baseline, not a cleaned production database.
Review the duplicate candidates and unlabelled provenance without bulk deletion.
Then choose one operational scenario and build its independently human-labelled
real-document benchmark (Orders 2–3). Prioritize attribution and normalization
before adding volume. Run-specific resolution snapshots and full shared-contract
integration remain explicit follow-ups; resolution accuracy is not certified.
