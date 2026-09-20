# Database and ROX: current assessment and next steps

> Order 1 audit and scorer repair are now documented in [DATABASE_ORDER1.md](DATABASE_ORDER1.md).
> That report supersedes the historical health, migration uncertainty and scoring behavior below;
> the old numerical scorecard is retained as historical evidence.

Updated 2026-09-19 America/Toronto (2026-09-20 UTC). Start here for database,
Reality, bulk data and ROX status. This is the current assessment; older release
reports remain historical evidence, not current completion checklists.

## What is verified

The preceding read-only Tiger audit queried stored rows; it did not run a new
benchmark, mutate data, or verify live commerce. Source was inspected both during
an unfinished merge and after aborting that merge. See [checkout status](LOCAL_MAIN_STATUS.md).
Stored scores cannot be attributed to an exact source revision from the evidence
collected. Preserve that distinction when reproducing them.

| Dataset              | Observed counts and provenance                                                                      | Interpretation                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `bulk_order_lines`   | 5,022,872 total; 1,032,918 original UCI rows (`pass=0`); 3,989,954 generated replay rows (`pass>0`) | 79.4% replayed; useful for load testing, not independent real-world evidence              |
| `bulk_products`      | 107,420 Open Food Facts records; 4,721 UCI-derived records                                          | 112,141 source-derived products; 95.8% OFF records                                        |
| Product prices       | All 107,420 OFF rows have `price_is_synthetic=true`; UCI rows are false                             | Real product attributes do not make generated prices real                                 |
| Operational fixtures | Supplier capacities, capabilities and fulfillment samples are documented as synthetic               | No verified real operational dataset established; current synthetic row count not audited |
| ROX corpus           | Generator documents 1,226 artifacts, eight document types and 17 chaos dimensions                   | Synthetic adversarial benchmark; generated corpus size is not the scored sample size      |
| Database size        | 1,363 MB during the audit                                                                           | Point-in-time size, not a capacity forecast                                               |

There is no verified synthetic percentage for the entire database. Products,
prices, events and sales overlap and have different units of measurement.
Intentional replay is not an accidental duplicate. Accidental duplicate rates
remain unaudited. Food is a valid e-commerce category, but this catalog does not
establish broad apparel/skincare coverage or Shopify market composition.

Synthetic data is useful for deterministic edge cases and scale tests. It cannot,
on its own, prove generalization to authentic supplier documents. Keep original,
replayed, synthetic and uncertain provenance distinguishable; do not delete or
merge records merely because they look similar.

## Process and schema, from input to action

Tables are linked collections of records: an artifact ID identifies a source,
a claim ID identifies a statement, and merchant/capability IDs identify who and
what the statement concerns. Preserve those links to explain every decision.

| Step                 | Tables / component                                                                  | Purpose                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1. Receive           | `raw_artifacts`                                                                     | Preserve source content, references, checksums and parse status                              |
| 2. Extract           | `rox_extractions`                                                                   | Model proposes facts with supporting text; these are not trusted facts yet                   |
| 3. Attribute         | `rox_entity_links`, `rox_alias_embeddings`                                          | Match aliases to merchants/capabilities; uncertain matches need review                       |
| 4. Normalize         | `canonical_claims`, `quarantined_claims`                                            | Standardize values and units, or record why a value cannot be used                           |
| 5. Resolve           | `canonical_resolutions`, `claim_conflicts`                                          | Compare authority, recency, confidence and corroboration; retain unknown/conflicted outcomes |
| 6. Plan              | `merchants`, `capabilities`, Reality, solver, reservations                          | Find candidates and certify feasibility against supplied facts; reserve capacity             |
| 7. Act               | `rox_review_queue`, Shopify adapter, receipts                                       | Propose follow-ups/write-backs; approved execution must be traceable and idempotent          |
| 8. Replay / evaluate | `molecule_events`, `rox_ingest_runs`, `rox_truth`, `rox_scorecard`, `rox_llm_calls` | Audit transitions, compare with the benchmark answer key, record cost and outcomes           |

A resolved fact is the scoring policy's selection, not independently verified
truth. Solver certification establishes feasibility against its inputs, not the
truth of those inputs. The bulk sales/product datasets are separate: more sales
rows do not automatically improve merchant attribution or claim resolution.

Other schema groups: `shopify_products`/`shopify_variants` mirror provider state;
`bulk_sales_daily`/`bulk_product_monthly` support analytics; migration 017 staging
and migration 018 immutable catalog versions are separate handoff mechanisms.
Staging or offline review does not establish executable readiness.

## Pattern recognition exists, with limited validation

[Rule mining](../rox_data/pipeline/rules.mjs) asks a model to propose parsing
patterns for product quantity labels, evaluates them, applies accepted rules in
JavaScript, and escalates residual labels to a model. For example, `6 x 330 ml`
should become 1,980 ml. This is a quantity parser, not a general demand predictor
or a learned supplier-truth model. Entity matching is a separate hybrid pipeline.

The live audit found four accepted rules, eight candidates and two rejected rules.
`bulk_product_quantities` held 59,383 rule results, 161 model results and 276
unparseable results. These are stored method counts, not full-catalog coverage.
Accepted rules had evaluation support of 3, 21, 90 and 3 examples, with reported
agreement of 100%, 100%, 96.7% and 100% respectively. The holdout is model-labelled,
not human truth. Three examples cannot establish broad reliability. An independent
human-labelled test set is still needed.

## Stored ROX scorecard and its limits

Run `rox-20260919210029-d119c8a7`, variant `agent`; stored score timestamps observed
around 2026-09-20 00:19 UTC. These results were retrieved, not recalculated.

| Metric                          | Stored value  | Meaning / caveat                                                                              |
| ------------------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| Artifacts / truth rows included | 360 / 675     | Subset with stored extractions, not all attempted documents                                   |
| Extraction precision / recall   | 90.5% / 96.6% | Value matches against generated expected statements                                           |
| Attribution accuracy            | 49.6%         | Correct merchant and full field among matched extractions checked                             |
| Normalization accuracy          | 48.2%         | Includes missing outcomes; not isolated unit-conversion accuracy                              |
| Quarantine recall               | 52.4%         | Expected bad facts quarantined without a claim                                                |
| Ambiguity held                  | 76%           | Checked ambiguous facts not promoted into claims                                              |
| Injection defense               | 100%          | Checked injection cases with no extraction promoted into a claim                              |
| Outlier containment             | 100%          | Evaluator's containment result, not independently certified                                   |
| `hallucination_rate_pct`        | 0%            | Counts stored candidates dropped for evidence reasons; does not prove zero unsupported claims |
| Recorded run cost               | USD 1.5414    | Stored ledger value; not an independently audited cost                                        |

[Scorer source](../rox_data/pipeline/score.mjs) has material evaluation limitations:

- Documents with zero extraction rows disappear from the scored population,
  potentially hiding complete failures and inflating recall.
- Candidate matching is by source path and field kind, choosing the closest value;
  it is not a strict one-to-one matching of predicted and expected facts.
- Normalization includes upstream missing outcomes. The restored local revision
  compares with underlying truth and handles fewer truth-unit conversions; the
  merge-side revision previously inspected compared with canonicalized stated
  values. Record the evaluator revision before comparing scores.
- Outlier evaluation reads current global resolutions, not a run-frozen snapshot;
  its unit comparisons and attribution to the run need auditing.
- A zero evidence-drop counter does not prove accepted claims are supported.
- Stored score rows can be overwritten for the same run/variant; preserve the
  code revision, dataset hash, configuration, raw counts and snapshot for future tests.

Treat these as diagnostics. They suggest attribution/normalization need attention,
but do not establish production accuracy. The audit did not find a stored regex
baseline scorecard; do not claim an agent-versus-baseline improvement yet.

## Current implementation and acceptance gaps

Extraction, linking, normalization, resolution, quarantine, scoring, baseline,
rule mining and action proposals exist. This is not an absent pipeline, but its
end-to-end reliability remains unproven.

The observed action run recorded 13 drafts, four write-back proposals and zero
applied write-backs. Local `act.mjs` queues proposals; `--apply` changes approval
metadata and does not itself execute a Shopify mutation. A separate write-back
script exists; integration and successful approved execution need evidence.

Earlier local catalog acceptance passed 100 synthetic recipes with mocked commerce,
but reported webhook source-identity and durable recovery failures. See
[delivery review](CATALOG_DELIVERY_REVIEW.md). Local changes touch those paths;
they were not retested by this documentation task, so neither fixed nor still
failing is established for this checkout.

The old Tiger read-only/storage incident and catalog advisory-lock incident are
historical. This audit explicitly set its session read-only; its `on` result does
not prove the server remains write-blocked. `rox_artifact_attempts` now exists,
so the old claim that migration 016 is unapplied is not a reliable current status;
check the migration ledger before certifying complete application. Do not kill
another workstream's session or rerun old maintenance SQL without diagnosis.

## Prioritized work: one problem at a time

| Order | Task                                                                                           | Completion evidence                                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Audit data provenance, accidental duplicates, migration state and health; repair scoring       | Reproducible inventory and scorer that includes every attempted artifact, including empty/error results                          |
| 2     | Choose one practical scenario; [StitchWorks apparel availability selected](DATABASE_ORDER2.md) | Defined inputs, uncertainty policy and useful downstream action                                                                  |
| 3     | [Collect authorized real examples; independently label answers](DATABASE_ORDER3.md)            | Versioned held-out dataset, human review, clear synthetic versus real reporting                                                  |
| 4     | Fix attribution and normalization; consolidate shared contracts/resolution                     | Focused tests plus stage and end-to-end results against the corrected benchmark                                                  |
| 5     | Close the action loop                                                                          | Evidence -> resolution -> approved write-back -> solver-certified replan -> durable receipt; retries create no duplicate effects |
| 6     | Measure Tiger's contribution and expose provenance in the UI                                   | Reproducible query timings, matching quality, storage/aggregate benefit and restart/replay evidence                              |

Do not expand replay volume, store count or vision scope before these gates.
Retain synthetic stress tests separately from real-data evaluation. Do not invent
operational facts to fill a broader catalog. `rox_data` currently duplicates
resolution logic outside the pnpm workspace; shared contracts/adapters and
integration tests are a remaining integration task.

## ROX and Tiger positioning

[Official event prize descriptions](https://hackthenorth2026.devpost.com/) frame
ROX around useful agents handling messy, incomplete or conflicting information.
The strongest demonstration is contradictory supplier evidence -> attributable
facts -> explicit uncertainty -> clarification -> a verified useful action.

Tiger features already represented include hypertables, compression, continuous
aggregates, trigram/vector entity matching and durable event persistence. Installed
extensions are not proof of effective use. Measure how these improve this workflow;
adding features without a demonstrated benefit is not the next priority. Reality's
lexical candidate search and ROX vector entity matching are different paths.

## Documentation map

- [Reality API and historical release evidence](TIGER_ROX_RELEASE.md)
- [Current owner task priorities](TASKS/TIGER_ROX.md)
- [Bulk dataset sources and scripts](TASKS/BULK_DATA_LOOP.md)
- [Shopify sync/write-back design](TASKS/SHOPIFY_DATA_PIPELINE.md)
- [Shopify ingestion implementation plan](TASKS/SHOPIFY_TIGER_INGESTION.md)
- [Catalog staging](CATALOG_HANDOFF.md) and [delivery acceptance](CATALOG_DELIVERY_REVIEW.md)
- [Original ROX design](../rox_data/PLAN.md) and [commands](../rox_data/README.md)

The implementation playbook and older integration/release reports describe their
own historical checkpoints. This assessment supersedes their mutable status and
priorities; it does not replace runtime contracts or erase previous test evidence.
