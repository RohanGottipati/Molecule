# Review a catalog delivery before import

> Status reconciled 2026-09-19: [current database/ROX assessment](DATABASE_ROX.md) is the
> source for current counts, evaluation caveats and priorities. Historical test
> results and incidents below apply only to their recorded revision/environment.

The offline delivery-review command uses the canonical schemas and
`validateCatalogJsonl` from `@molecule/contracts`. It adds sample coverage and
evidence checks without connecting to Tiger, Shopify or another provider.

Run it from the repository root:

```sh
node --import tsx packages/contracts/src/scripts/review-delivery.ts delivery.jsonl --profile sample --output sample-review.json
node --import tsx packages/contracts/src/scripts/review-delivery.ts delivery.jsonl --profile recipe-set --output recipe-set-review.json
```

Omit `--output` to print JSON to standard output. Output files must be new; the
command refuses to overwrite existing reports or the delivery. Input is limited
to a regular file of 256 MiB. Larger deliveries should first provide a
self-contained sample that includes all referenced merchant, product, variant,
family, fact, binding and resource records. A recipe-only fragment is invalid.

## Profiles and outcomes

`sample` checks for at least 20 recipe definitions, including an individual
product recipe and product records for every one of the 12 initial categories.
Taking the first 20 rows of a category-sorted delivery is not representative.

`recipe-set` checks for at least 100 recipe definitions, eight individual recipes
per initial category, four bundles, and a bundle definition that requires at least
seven distinct suppliers. The actual supplier graph is verified later by the
Python solver, not by counting names in this report.

Both profiles report:

- Structural validation errors, unresolved facts and excluded bindings.
- Category coverage and bindings with resolved evidence. These counts are zeroed
  if structural errors make the catalog graph invalid.
- Synthetic versus non-synthetic source records. Non-synthetic does not mean
  independently verified.
- Possible recipe duplicates that differ only in wording, color, size, quantity
  or personalization. This is a structural review hint, not a semantic proof;
  graph ordering and unstructured product names can affect the comparison.
- The input SHA-256, catalog version and supplied taxonomy. The other 20 category
  labels remain pending; no labels are invented to reach the target of 32.

| Status                          | Meaning                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `INVALID_DELIVERY`              | JSON, schemas, counts or references failed validation.                      |
| `INCOMPLETE_SAMPLE_DEFINITIONS` | The chosen profile lacks required recipe/product coverage.                  |
| `REVIEW_REQUIRED`               | Evidence gaps, unavailable bindings or possible recipe padding need review. |
| `READY_FOR_INTEGRATION_REVIEW`  | These intake checks passed; database and solver checks are next.            |

Exit code `0` means ready for integration review, `1` means the report contains
review items, and `2` means invalid command arguments or a file operation failed.

The report always records `solverCertified: false`, `databaseImported: false`
and `liveExecutionVerified: false`. A successful review does not certify material
compatibility, availability, scheduling, prices, device compatibility, assets or
execution. It does not import or activate the catalog.

## Handoff to integration

Agree the manifest and send a self-contained 20-recipe sample first. Resolve
structural errors and review evidence gaps while retaining explicit unknown or
conflicted facts. Then test ingestion in an isolated PostgreSQL database and run
the actual Python solver. Only after those checks should the full delivery be
imported and an approved catalog version activated.

The separate `scripts/catalog-handoff.mjs` command handles structural validation,
import and activation. This review command adds release-definition checks; it is
not a replacement for that importer. The draft `017` handoff staging tables are
also separate from `018`'s immutable catalog versions. No automatic promotion
from staging is performed here.

Tests live in `packages/contracts/src/delivery-review.test.ts`. They exercise the
synthetic broad catalog fixture, missing coverage, unknown timing, invalid
references, operation outages, color-only padding and safe command output.

## Local verification on 2026-09-19

The intake report passed for both the representative synthetic 20-recipe sample
and the 100-recipe fixture. Reports are saved under
`.molecule-data/catalog-delivery-review/`. No teammate delivery was used.

The existing broad-catalog integration suite also ran all 100 recipes against the
actual Python solver, isolated local PostgreSQL and deterministic Shopify mocks.
It passed all 100 scenarios, with 324 supplier-job receipts across 12 categories.
The onboarding showcase used eight distinct suppliers. The test asserts a
composite-product receipt for every recipe, selected catalog references on plan
nodes, quantity/cost checks, persisted events, retry identity and job supersession.

Evidence: `.molecule-data/catalog-delivery-review-durable.json`, catalog version
`broad-test-2228d31a-9d10-4ed5-ae66-234842d6959b`. This is **synthetic, local, mocked
commerce evidence**, not live Shopify evidence. Set `BROAD_CATALOG_EVIDENCE_PATH`
to a distinct file under `.molecule-data` to keep concurrent verification runs
from overwriting each other's reports.

Other passing checks: 26 contract tests, 27 database tests, 90 solver tests,
22 Shopify client mock tests and 46 orchestrator tests without database gates.
Contract and orchestrator lint/typecheck passed after rebuilding dependency
declarations. New report files and the broad integration test pass formatting.

The default orchestrator run skipped 106 database-gated tests. The 100 broad
scenarios were exercised separately as described above. Running the other six
gated cases explicitly exposed these remaining failures:

| Gate                      | Result             | Observation                                                                                                |
| ------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Shopify batch ingestion   | 1 passed           | Repeat ingestion preserved claim identity and skipped the unmapped store.                                  |
| Shopify webhook ingestion | 1 failed           | Expected resolved capacity `0`, received `conflicted`. Reproduced in a fresh local database.               |
| Legacy durable runtime    | 2 passed, 2 failed | One recovery produced `NEEDS_HUMAN`; another scenario returned `UNSAT` where the fixture expected `VALID`. |

For the webhook failure, the persisted snapshot source was
`gid://shopify-mock/ProductVariant/125`, while the webhook source was
`gid://shopify/InventoryItem/gid://shopify-mock/ProductVariant/125`. These cannot
form one observation stream, so the old claim is not superseded. The mock snapshot
also omitted the observation timestamp in the extracted claim. The seeded
StitchWorks merchant has other contradictory capacity evidence that must not be
silently overwritten to make this assertion pass. Fix and retest the source
identity/observation mapping and scenario isolation before closing G5.

The legacy runtime failure included a later 200-unit request seeing only 180
units available at ThreadForge and unresolved StitchWorks evidence. Check
reservation cleanup and scenario isolation before interpreting this as a solver
defect. No failing assertion was weakened, and no provider implementation was
changed by the delivery-review work packet.

Shared Tiger migration, teammate data acceptance, the complete recovery matrix,
14-store provisioning and the 13 live Shopify demonstrations remain pending.
