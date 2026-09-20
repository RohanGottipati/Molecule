# ROX pipeline repair: implementation plan

Written 2026-09-19 for an agent picking this up cold. Scope: make the agentic
messy-data pipeline actually drive the real-time marketplace, and make the
resolver — not a mutable column — the authority on what a supplier fact is.

Supersedes nothing. Read [DATABASE_ROX.md](../DATABASE_ROX.md) and Orders
[4](../DATABASE_ORDER4.md) / [5](../DATABASE_ORDER5.md) / [6](../DATABASE_ORDER6.md)
first; this plan is the work those documents list as "not done", sequenced.

## 0. Decisions already made

Do not relitigate these without the owner.

| Decision                      | Choice                                                                    |
| ----------------------------- | ------------------------------------------------------------------------- |
| Capacity uncertainty policy   | **Strict.** `ROX_CAPACITY_POLICY=strict` is the product default           |
| `rox_data` / workspace split  | **Full migration** into the pnpm workspace; delete the duplicate resolver |
| Claim field naming convention | **`resource.<resourceId>.<inventory\|capacity>`** wins                    |
| `services/orchestrator`       | **In scope.** Keep orchestrator edits in separate commits                 |

Strict means recall drops on purpose: 214 of 334 synthetic capacity extractions
go to review instead of becoming claims, in exchange for 0 wrong claims
(Order 4). Never "fix" a low resolved-fact count by loosening it.

## 1. Confirmed current state

Verified by direct read at `48bc143` on 2026-09-19. Trust this; don't re-derive it.

**Three incompatible claim-field conventions exist, and the read path honours one.**

| Convention                              | Written by                                                | Read by                                                      |
| --------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `capacity_per_day` (unscoped)           | `services/orchestrator/src/shopifyRealityIngestion.ts:79` | `applyFacts` in `services/reality/src/service.ts:56`         |
| `resource.<resourceId>.inventory`       | `services/reality/src/catalogInventory.ts:86`             | **nothing**                                                  |
| `catalog.<version>.<bindingId>.<field>` | catalog handoff                                           | `catalogCandidates` in `services/reality/src/catalog.ts:113` |

- **The unscoped field is why capacity is always conflicted.** `ingestClaim`
  supersedes prior claims only within
  `(merchant_id, field, source_kind, source_reference)`
  (`services/reality/src/repository.ts`). Every Shopify inventory item is a
  different `source_reference` but shares the field `capacity_per_day`, so N
  inventory items become N rival values for one field and `resolveClaims` returns
  `conflicted`. Order 5 confirms this empirically: **all 9 live capacity
  resolutions are conflicted**, so zero suppliers are currently excludable.
- **`canonical_resolutions` is written and never read on the hot path.**
  `repository.ts` inserts it; the only readers are `rox_data/pipeline/act.mjs`,
  `scripts/shopify-writeback.mjs` and `packages/db/src/reservations.ts`.
  `searchCandidates` instead re-resolves raw `canonical_claims` in memory on
  every request.
- **Provenance is decorative on the catalog path.**
  `observeCatalogInventory` overwrites `catalog_resource_state.available`
  (`catalogInventory.ts:79-82`) _before_ ingesting the claim and resolving. The
  resolver's verdict cannot hold back the value that
  `catalogCandidates` then serves. Its only conflict lever is the crude
  same-timestamp tie at line 72-75.
- **`rox_data` cannot import contracts.** `rox_data/package.json` says
  "Deliberately outside the pnpm workspace"; `pnpm-workspace.yaml` globs only
  `apps/*`, `services/*`, `packages/*`. Consequence:
  `rox_data/pipeline/resolve.mjs` (211 lines) is a hand-copy of
  `services/reality/src/resolution.ts` (144 lines), free to drift.
- **Shopify ingestion reads one structured number.**
  `extractCapacityClaims` (`packages/shopify/src/reality-extract.ts:55`) maps
  tracked inventory quantity only. No description, metafield, or policy text is
  extracted. There is no LLM in this path at all.
- **Supplier identity is a 7-role allowlist.** `merchantIdForShopifyStore`
  returns `undefined` for anything outside `INGESTIBLE_ROLES`, and the caller
  skips it silently. Order 4 separately reports **154 extractions unattributed**
  because merchant-level alias resolution is unaddressed.
- **Already done, do not rebuild:** strict capacity policy
  (`rox_data/pipeline/capacity.mjs`), attribution
  (`rox_data/pipeline/attribution.mjs`), the availability decision rule
  (`rox_data/pipeline/availability.mjs`, 13 tests), scorer population repair
  (Order 1), Tiger benchmark (Order 6).

## 1a. Delivered 2026-09-19 (A1, A2, and the resolution invariant)

Verified against a disposable local Postgres 17 (no TimescaleDB), migrated and
seeded from scratch. `pnpm typecheck` and `pnpm lint` are 23/23; unit and
DB-gated tests pass for `@molecule/db` (5 files), `@molecule/service-reality`
(6), `@molecule/orchestrator` (13, 1 skipped), `@molecule/shopify` (7),
`@molecule/rox-data` (91 tests) and the new `@molecule/resolution` (12).

- **A1 done.** `rox_data` is a workspace package (`pnpm-workspace.yaml`), so it
  imports shared code instead of re-declaring it.
- **A2 done.** New `packages/resolution` (`@molecule/resolution`) holds the one
  resolver: weights, conflict margin, `stableJson`, `resolveClaims`,
  `resolveMerchantFields` and a `claimFromRow` adapter for snake_case rows.
  `rox_data/pipeline/resolve.mjs` lost its scoring copy, and
  `services/reality/src/resolution.ts` is now a re-export.
  - **The two copies had already drifted**, exactly as feared: the ROX copy
    compared candidate values while ignoring `normalizedUnit`, so "40 units/day"
    and "40 units/week" counted as _corroboration_ instead of a conflict. The
    shared module keeps Reality's unit-aware comparison, and
    `packages/resolution/src/index.test.ts` pins it as a regression test.
- **Three pre-existing integration failures fixed** (they failed before any of
  this work, on a fresh database):
  - `honors resolved prefixed inventory in candidate reads and reservations`
  - `honors unknown prefixed inventory in candidate reads and reservations`
  - `returns every kit component, two embroidery options, evidence and risk...`

### The bug those failures were reporting

`reserveCapacity` read the `canonical_resolutions` snapshot while candidate
search resolved `canonical_claims` live. **Seeding writes claims and never
resolved them**, so `canonical_resolutions` was empty: a merchant whose claims
said inventory was 0 disappeared from search but was still fully reservable.
On the demo path that is a judge zeroing out inventory, watching the supplier
vanish from the marketplace, and still being able to reserve 200 units.

Two changes close it:

1. `resolveMerchant` moved from `services/reality/src/repository.ts` into
   `packages/db/src/resolution.ts` (it only writes database tables, and `db` can
   now share the resolver). Reality re-exports it, so there is one persistence
   path.
2. `seedDemo` ends with `resolveAllMerchants`, making "claims are adjudicated"
   an invariant of a seeded database. The seeded 100/day, 50/day and fresh
   20/day conflict now resolves to 20/day with the losers marked `superseded` —
   the behaviour `docs/TASKS/TIGER_ROX.md` already claimed. `resetDemoData`
   calls `seedDemo`, so demo reset is covered too.

### Deviation from B5, with evidence

The plan said "read `canonical_resolutions` in `searchCandidates`". The
implementation did the **opposite**: `reserveCapacity` now resolves live like
search does. Reason: the snapshot is not reliably populated (that was the bug),
so making the hot read path depend on it would have spread the defect rather
than contained it. `canonical_resolutions` remains the audit and provenance
record, written transactionally by `resolveMerchant`. Revisit the caching
direction only once B4 lands and population is guaranteed; then B5 becomes a
measured performance change rather than a correctness one.

One test was rewritten rather than deleted: `@molecule/db`'s "honors scoped
daily-capacity facts" drove `reserveCapacity` by inserting into
`canonical_resolutions` directly. It now expresses the same three intentions
through `canonical_claims`, which is the authoritative source.

## 2. Rules

- Import domain schemas from `@molecule/contracts`. The migration in P0-A exists
  precisely so `rox_data` can stop redefining them.
- LLMs propose; only the deterministic resolver certifies. A change that lets an
  extraction reach `catalog_resource_state` without passing resolution is a
  regression even if it improves a score.
- `unknown` and `conflicted` are terminal states, not failures to engineer away.
- Additive SQL only. Never rewrite migrations 001-020; add 021+.
- Every state change emits a `MoleculeEvent` with a `traceId`.
- Never widen `INGESTIBLE_ROLES` to make more data flow. Fix attribution instead.
- Do not expand corpus volume, store count, or vision scope before P0 and P1
  close. `DATABASE_ROX.md` gates this explicitly.
- Keep synthetic and real evaluation reported separately, always.

## 3. P0 — make the pipeline authoritative (blocks everything else)

### A. One resolver, one contract set

- [x] **A1.** Add `rox_data` to `pnpm-workspace.yaml` packages. Keep the package
      name `@molecule/rox-data`. Accept: `pnpm install` resolves it and
      `pnpm --filter @molecule/rox-data test` runs the existing
      `rox_data/tests/*.test.mjs` unchanged.
- [x] **A2.** Delete the scoring half of `rox_data/pipeline/resolve.mjs` and
      import `resolveClaims` / `RESOLUTION_WEIGHTS` / `CONFLICT_MARGIN_THRESHOLD`
      from the shared module. Publish the resolver from `@molecule/contracts` (or
      a new `@molecule/resolution` package) so both `services/reality` and
      `rox_data` consume one implementation. Accept: a fixture set of conflicting
      claims produces byte-identical decisions before and after; the duplicated
      scoring code is gone, not merely unused.
- [ ] **A3.** Move the strict capacity policy (`rox_data/pipeline/capacity.mjs`)
      and attribution thresholds into the shared package, and make
      `normalizeValue` in `services/reality/src/ingestion.ts` delegate to it.
      Today that function understands 8 numeric field names and a tight regex;
      strict period/window/range handling must apply to _every_ ingestion
      boundary, not only the ROX CLI. Accept: `"500"` with no period is
      `needs_review: no_period` whether it arrives via the ROX pipeline or
      `POST /api/reality/ingest`.
- [ ] **A4.** Delete `ROX_CAPACITY_POLICY=legacy` from the default path; keep it
      reachable only from `compare-policies.mjs` for historical reproduction.

### B. One field convention, and resolution on the read path

- [ ] **B1.** Retire the unscoped `capacity_per_day` writer. Route
      `ingestShopifyCapacityBatch` and the inventory webhook through
      `observeCatalogInventory`, which already resolves
      `(shopify_domain, inventoryItemGid, locationGid)` to a `resource_id`.
      Delete `extractInventoryCapacityClaim` and `extractCapacityClaims`'
      unscoped output. Accept: no code path writes a claim whose field lacks a
      resource or capability scope; an integration test asserts two different
      inventory items for one merchant resolve to **two independent resolved
      facts**, not one conflict.
- [ ] **B2.** Backfill/migrate existing unscoped claims. Migration 021: mark
      historical `capacity_per_day` claims `superseded` with a recorded reason
      rather than deleting them (provenance is evidence). Accept: the 9
      conflicted live capacity resolutions re-resolve; record before/after counts
      in `docs/evidence/`.
- [ ] **B3.** Make `applyFacts` and `catalogCandidates` read
      `resource.<id>.*` facts. Accept: a resolved resource fact changes candidate
      availability; a `conflicted` one produces a `blockedReasons` entry naming
      the field.
- [x] **B4. The important one.** Invert `observeCatalogInventory` so the claim is
      ingested and resolved _first_, and `catalog_resource_state.available` is
      updated only from the resolved fact. When resolution is `conflicted` or
      `unknown`, set `status` accordingly and leave the last known-good value in
      place, so `catalogCandidates` excludes the resource instead of serving an
      unvetted number. Accept: an integration test feeds two disagreeing sources
      for one resource at the same observation time and asserts the served
      availability does **not** move and a review item is queued. This is the
      whole "LLMs propose, deterministic code certifies" claim; without it the
      claim is false.
- [~] **B5.** Superseded by the delivered change in section 1a: reservations and
  search now share one live resolution path. The original text below is kept
  because the caching idea is still worth doing _after_ B4.
  Read `canonical_resolutions` in `searchCandidates` instead of
  re-resolving every claim per request, now that B4 makes it authoritative.
  Keep the resolution write transactional with ingestion. Accept: identical
  candidate output to the pre-change implementation on the seeded fixtures,
  plus a recorded query-timing comparison (Order 6 methodology).

### C. Trustworthy measurement

- [ ] **C1.** Add the run-frozen resolution snapshot Order 4 lists as missing, so
      resolution and outlier metrics stop reading current global state. Accept:
      re-scoring an old run reproduces its stored numbers exactly.
- [ ] **C2.** Re-run extraction for rows still on prompt `rox-extract-v3` (Order 4
      notes live Tiger rows were never re-normalized), then re-score.
- [ ] **C3.** Store the regex baseline scorecard next to the agent run.
      `baseline.mjs` exists; no stored baseline scorecard was found, so the
      "agent beats regex" claim is currently unevidenced. Accept: one table, same
      corpus, both variants, committed to `docs/evidence/`.

## 4. P1 — the differentiators

### D. Actually ingest unstructured supplier data

- [ ] **D1.** Extend the Shopify read beyond inventory counts: product
      descriptions, `molecule.*` metafields, shop policies. Keep
      `packages/shopify` pure — emit candidate records, run extraction in the
      pipeline. Accept: a lead-time or MOQ fact extracted from free-text
      description reaches a resolved fact with a cited evidence span.
- [ ] **D2.** Merchant-level alias resolution for the 154 unattributed
      extractions, reusing the `link` stage's exact → containment → trigram →
      pgvector ladder. Accept: unattributed count drops with precision reported;
      ambiguous cases become `needs_review`, never a guessed merge.
- [ ] **D3.** Replace the `INGESTIBLE_ROLES` allowlist with store→merchant
      resolution through `merchant_stores` plus D2's alias ladder. An unmapped
      store must produce a **review item**, not a silent skip. Accept:
      `printpress-*` yields a queued "unmapped supplier" item and a log line.

### E. Close the action loop

- [ ] **E1.** Add `POST /api/availability/changed` exactly as specified in
      [Order 5](../DATABASE_ORDER5.md): same authorization as `/api/chaos`,
      requires an `actionKey` belonging to an **approved** `rox_review_queue`
      row, idempotent on that key, calls
      `recoverSupplier(orderId, merchantId, resourceId)`, and leaves plan
      approval to the existing path. Separate commit.
- [ ] **E2.** Run the `act` stage's proposal section against the database end to
      end. Currently 4 proposals, 0 applied, never executed live.
- [ ] **E3.** Demonstrate one approved Shopify write-back with a durable receipt,
      and prove a retry creates no duplicate effect. Order 5 notes live data has
      no resolved-insufficient-capacity case — after B4 it should; if not,
      construct one through the corpus, not by hand-editing Tiger.

### F. Continuous, not batch

- [ ] **F1.** Trigger the pipeline from arriving artifacts/webhooks rather than a
      manual `node pipeline/run.mjs`. Accept: an artifact dropped in the inbox
      reaches a resolved fact with no human command.
- [ ] **F2.** Execute the database-gated webhook tests that G4/G5 in
      [SHOPIFY_TIGER_INGESTION.md](SHOPIFY_TIGER_INGESTION.md) left marked `[~]`
      (written, never run against `TEST_DATABASE_URL`).
- [ ] **F3.** Surface sync freshness and provenance in `apps/web` — the resolved
      value, its winning claim, and the evidence span. `DATABASE_ROX.md` Order 6
      lists exposing provenance as still open.

## 5. P2 — only after P0/P1 close

- [ ] **G1.** Order 3's authorized real-document holdout with human labels. This
      is the only thing that converts any of the above into a real-accuracy
      claim; it is blocked on authorization, not engineering.
- [ ] **G2.** Compress `network_events` and `market_metrics` (Order 6 notes both
      uncompressed).

## 6. Verification

Run for every touched package before checking a task off.

```sh
pnpm --filter @molecule/contracts lint typecheck test build
pnpm --filter @molecule/service-reality lint typecheck test build
pnpm --filter @molecule/orchestrator lint typecheck test build
pnpm --filter @molecule/shopify lint typecheck test build
pnpm --filter @molecule/rox-data test          # after A1

export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/molecule
export TEST_DATABASE_URL="$DATABASE_URL"
export SHOPIFY_TEST_DATABASE_URL="$DATABASE_URL"
pnpm verify:secrets
pnpm verify:kit                                 # not run since the merge

cd rox_data && npm test
node pipeline/compare-policies.mjs --snapshot ../.molecule-data/order1/historical-snapshot.json --output /tmp/cmp.json
```

Reality/Tiger work is a no-op under `STORAGE_MODE=local`; use
`STORAGE_MODE=postgres`.

## 7. Sequencing note

A → B is a hard dependency: unifying field names (B1) is pointless while two
resolvers can disagree about what they mean, and B5 is unsafe before B4 makes
`canonical_resolutions` authoritative. C is cheap and should land alongside B so
that B's effect is measurable. D/E/F are parallelizable once B closes. Do not
start P2.

Expect scores to drop when strict policy and B4 land together. A drop caused by
refusing to serve unvetted numbers is the intended outcome, not a regression —
report it next to the review-queue depth so the trade is visible.
