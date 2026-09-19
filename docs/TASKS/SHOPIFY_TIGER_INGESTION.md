# Shopify → Tiger ingestion: implementation plan

Written 2026-09-19 for an agent picking this up cold. Scope: the missing middle leg of
Shopify API → Tiger (Reality) → Shopify Admin. The write-back leg (Tiger/solver plan →
Shopify Admin via `@molecule/shopify`'s `ShopifyClient.commit()`) already exists and is
wired into `services/orchestrator`. The read leg (Shopify API → Tiger claims) does not
exist anywhere in this repo yet. This doc is scoped to building only that read leg.

Everything in section 1 was verified by direct grep/read against this repo on 2026-09-19.
Trust it; don't re-derive it before starting.

## 0. Read first

1. `AGENTS.md`, `docs/CONTRACTS.md` (route `POST /api/reality/ingest`).
2. `docs/SHOPIFY_RELEASE.md` — `@molecule/shopify` public API, webhook handler, and the
   explicit note that persisted webhook events "do not automatically insert into the
   separate Tiger event store."
3. `docs/TIGER_ROX_RELEASE.md` — `ingestClaim`, `resolveMerchant`, `DATABASE_URL` /
   `DEMO_MODE` config.
4. `docs/RELEASE.md` — `STORAGE_MODE=postgres` requirement. **This whole feature is a
   no-op under `STORAGE_MODE=local`**, because Reality/Tiger only exists in postgres mode.
5. Code: `packages/shopify/src/transport.ts`, `packages/shopify/src/webhooks.ts`,
   `packages/shopify/src/catalog/{types,mock-adapter}.ts`,
   `services/reality/src/repository.ts` (`ingestClaim`),
   `services/reality/src/ingestion.ts` (`RawClaimInput`, `normalizeValue`),
   `packages/test-fixtures/src/seed-data.mjs` (`MERCHANT_IDS`, `roleForStore`),
   `sql/004_seed.sql` (seeded `merchants` rows), `sql/007_shopify.sql` (Shopify's own
   event/webhook tables), `services/orchestrator/src/durableRuntime.ts` (exact
   integration point, see section 2).

## 1. Confirmed current state — the gap

- **Nothing calls `ingestClaim` (or `POST /api/reality/ingest`) with Shopify-sourced
  data anywhere in this repo.** Verified by grepping every `.ts`/`.mjs` file for
  `ingestClaim(` and `SHOPIFY_SNAPSHOT`: `ingestClaim` is only called from Reality's own
  HTTP server (`services/reality/src/server.ts`) and internal seed/chaos code
  (`services/reality/src/service.ts`). Nothing that reads Shopify calls it.
- **Read primitives already exist** and don't need to be rebuilt:
  - `ShopifyTransport.listProducts(after?)` and `.getInventory(inventoryItemId)` in
    `packages/shopify/src/transport.ts` — live GraphQL reads, schema-validated.
  - `@molecule/shopify/catalog`'s `MockShopifyAdapter.getSnapshot(shop)` — capacity +
    products, no network, deterministic. Use this to build/test the pipeline without
    live credentials.
- **`ingestClaim(input: RawClaimInput, traceId, client?)`**
  (`services/reality/src/repository.ts:164`, re-exported from `@molecule/service-reality`)
  is the exact call to make:
  ```ts
  interface RawClaimInput {
    merchantId: string;
    field: string;                // use "capacity_per_day" for capacity items
    rawValue: unknown;
    sourceKind: "shopify" | ...;  // CanonicalClaim["source"]["kind"]
    sourceReference: string;      // Shopify GID (product or variant id)
    sourceChecksum?: string;
    observedAt?: string;          // ISO datetime
    sourceAuthority: number;      // 0..1
    extractionConfidence: number; // 0..1
    evidenceText?: string;
  }
  ```
  It throws `"Unknown merchant"` if `merchantId` isn't a row in the `merchants` table.
  It is **idempotent for free**: it hashes the full input (`stableJson` + sha256) into
  `artifact:<hash>` and no-ops on a repeat, so re-processing the same fact (e.g. from a
  duplicate webhook or a re-run batch) is always safe. No new `actionKey` scheme needed.
- **Merchant ID mapping**: use `MERCHANT_IDS` from
  `packages/test-fixtures/src/seed-data.mjs:48` (`basegoods → base-goods`,
  `stitchworks → stitch-works`, etc.) — confirmed to match the actual seeded
  `merchants` rows in `sql/004_seed.sql:9-16`. **Do not use the `m-<role>` convention**
  seen in `packages/test-fixtures/src/index.ts` (`BASEGOODS_CAPABILITY`,
  `CUSTOMIZECO_CAPACITY_CLAIMS`) — that's a separate, older `kit.ts` fixture unrelated
  to the current release catalog / merchants table.
- **Not every store has a merchant row.** `sql/004_seed.sql` seeds exactly 7 merchants:
  `base-goods, stitch-works, thread-forge, needle-north, laser-lab, snack-box, pack-ship`.
  The 8 real Shopify dev stores are `molecule-storefront, stitchworks-*, threadforge-*,
basegoods-*, laserlab-*, packship-*, snackbox-*, printpress-*`. Note: **`printpress`
  has no merchant row**, and **`needle-north` has no Shopify store**. The ingestion code
  must skip a store whose role has no matching merchant row (log and continue), not
  throw and abort the whole batch.
- **Webhook receiving has two gaps, not one:**
  1. `handleShopifyWebhook` (`packages/shopify/src/webhooks.ts`) verifies HMAC, checks
     topic/domain, and persists an event via `ShopifyActionRepository.recordWebhook` —
     but only into Shopify's own tables (`molecule_shopify_events`,
     `molecule_shopify_webhooks` from `sql/007_shopify.sql`), not into Tiger.
  2. **No HTTP route anywhere in this repo actually calls `handleShopifyWebhook`.**
     Verified: `grep -rl "handleShopifyWebhook" services/orchestrator/src apps` returns
     nothing. `apps/shopify-app` has no source files at all (only a `docs/` folder).
     `handleShopifyWebhook` currently only runs inside its own unit test. This means
     Shopify webhooks cannot reach this system live yet, at all — this is a prerequisite
     blocker for the reactive path (section 4, G4), independent of Tiger ingestion.
- **The integration point that already exists**, `services/orchestrator/src/durableRuntime.ts`:
  - Line 26: `const reality = createRealityService();` — Reality is already constructed
    in-process here. **No HTTP hop is needed**; call `ingestClaim` directly (it's
    exported from `@molecule/service-reality` per `docs/TIGER_ROX_RELEASE.md`).
  - Line 91-95:
    ```ts
    const repository = new PostgresShopifyActionRepository(
      getPool(),
      `shopify-${config.SHOPIFY_MODE}`,
    );
    for (const event of await repository.events()) await store.append(event);
    ```
    This already replays every persisted Shopify event (including any future webhook
    events) into the orchestrator's own event store on startup — but not into Tiger.
    This is the natural place to also feed `inventory_levels/update` events into
    `ingestClaim` as a startup catch-up pass.
  - `repository.events(orderId?)` returns **all** events for the namespace when
    `orderId` is omitted, ordered, but with no cursor param. Fine for hackathon volume:
    rely on `ingestClaim`'s built-in checksum idempotency instead of building new cursor
    infrastructure.

## 2. Design decision (recommended — flag to a human only if they disagree)

- Keep `packages/shopify` free of any `@molecule/service-reality` import. Per
  `AGENTS.md`'s "Do not edit another owner's provider package without explicit
  coordination," and to avoid a new cross-package dependency, `packages/shopify` should
  only expose a **pure extraction function**: `ShopifySnapshot` (or a webhook payload) →
  `RawClaimInput[]`. No network call to Reality from inside `packages/shopify`.
- Put the actual `ingestClaim` calls in **`services/orchestrator`**, which already
  depends on both `@molecule/shopify` and `@molecule/service-reality` in-process (see
  `durableRuntime.ts` above). This keeps ownership boundaries clean and needs no new
  workspace dependency edges.
- This feature only runs under `STORAGE_MODE=postgres` / `SHOPIFY_MODE=live` (or
  `demo`, against the mock) — it is a deliberate no-op under `STORAGE_MODE=local`,
  matching how Reality itself already behaves.

## 3. Rules

- Same guardrails as `docs/TASKS/SHOPIFY_LOOP.md` section 2: never print secrets, never
  push, never wipe stores, stage files by name, small commits.
- `packages/shopify` code must stay usable with **no network and no env** for its unit
  tests (extraction function is pure — test it against `MockShopifyAdapter.getSnapshot`
  fixtures, not live Shopify).
- Every ingestion call needs a `traceId` (per-batch-run UUID is fine; per-webhook use
  the webhook's own `eventId`).
- Do not invent a new dedupe/actionKey scheme for this — `ingestClaim`'s checksum
  idempotency already covers retries and duplicate webhooks.
- Skip merchants with no matching row; log the skip, don't throw and abort the batch.
- No contract changes needed — `POST /api/reality/ingest` and `RawClaimInput` already
  cover this. If you find a genuine gap, an additive change only, per `AGENTS.md`.
- Before marking any task `[x]`: run `pnpm --filter <touched packages> lint typecheck
test build`, and for anything touching Postgres, the `TEST_DATABASE_URL` /
  `SHOPIFY_TEST_DATABASE_URL` pattern already used by `docs/RELEASE.md`.

## 4. Tasks (do in order; each is a small, separately-committable unit)

- [ ] **G1. Extraction function.** In `packages/shopify` (e.g.
      `packages/shopify/src/reality-extract.ts`): a pure function
      `extractCapacityClaims(snapshot: ShopifySnapshot, merchantId: string): RawClaimInput[]`
      that turns each `ShopifyCapacityItem` into one `RawClaimInput` with
      `field: "capacity_per_day"`, `sourceKind: "shopify"`,
      `sourceReference: item.itemId`, `rawValue: item.quantity`,
      `sourceAuthority: 0.9` (live tracked inventory beats marketing copy but isn't a
      merchant-submitted note), `extractionConfidence: 1`,
      `evidenceText: "<title> tracked inventory = <quantity>"`. Accept: unit tests using
      `MockShopifyAdapter.getSnapshot("stitchworks-...")` fixtures, no network.
- [ ] **G2. Role → merchantId mapping + skip-unknown helper.** Reuse `MERCHANT_IDS` and
      `roleForStore` from `@molecule/test-fixtures`. A small helper that, given a store
      handle, returns the mapped `merchantId` or `undefined` if unmapped (e.g.
      `printpress`). Accept: unit test asserts `printpress-*` → `undefined`,
      `stitchworks-*` → `"stitch-works"`.
- [ ] **G3. Batch ingestion wired into the orchestrator.** In
      `services/orchestrator/src/durableRuntime.ts`, near line 95: for each configured
      store with a mapped merchant, get a snapshot (mock or real, mirroring how `commerce`
      is already constructed by `SHOPIFY_MODE`), run G1's extraction, call `ingestClaim`
      for each claim with a per-run `traceId`. Accept: integration test against a disposable
      Postgres (`TEST_DATABASE_URL`, matching the pattern in `docs/RELEASE.md`) — seed
      produces expected `accepted`/`quarantined` counts, an unmapped store is skipped not
      thrown, and running the batch twice produces the same claim IDs (checksum idempotency).
- [ ] **G4. Mount the webhook HTTP route.** Prerequisite gap, not previously scoped
      anywhere: add an actual Fastify route (in `services/orchestrator`, alongside wherever
      `index.ts`'s `app` is otherwise configured) that reads the **raw request body**
      (required for HMAC — verify before any JSON-parsing middleware runs) and calls
      `handleShopifyWebhook({ secret, allowedDomains, repository, maxBodyBytes }, { rawBody,
headers })`. Map its result/thrown `ShopifyError` codes to HTTP status per
      `docs/SHOPIFY_RELEASE.md`'s "Webhooks" section (401/413/400/503/200). Accept: an
      integration test posts a signed `inventory_levels/update` payload to the running
      route and asserts 200 + the event lands in `molecule_shopify_events`.
- [ ] **G5. Reactive re-ingestion.** After G4's route accepts a webhook (status
      `"accepted"` or `"duplicate"` both fine — duplicate just means checksum will no-op),
      extract the affected item from the webhook payload
      (`inventory_item_id`/`available`/`location_id` — already parsed and persisted, see
      `packages/shopify/src/webhooks.ts:60-71`) and call `ingestClaim` for just that one
      claim, using the webhook's own event/delivery ID as part of the `traceId`. Accept: an
      end-to-end test simulates a webhook dropping a known capacity item to 0, then calls
      `resolveMerchant` (or `GET /api/reality/merchants`) and asserts the resolved
      `capacity_per_day` fact is now `0` with a `source.kind === "shopify"` contributing
      claim — i.e. the self-heal chain moves without a human re-running anything by hand.
- [ ] **G6 (stretch, only if P0-P1 done with time to spare).** Surface a
      "Tiger last synced with Shopify at HH:MM:SS" signal (an event or a marketplace field)
      so the demo narrator/judge can see freshness live.

## 5. Fallback if time runs out

Ship G1-G3 only (batch ingestion) and skip G4/G5. Before the demo's self-heal moment,
manually re-run the batch ingestion script/endpoint right after the judge edits Admin
inventory, instead of relying on a live webhook. Document this fallback explicitly in
`docs/DEMO_RUNBOOK.md` if it's the path taken, so nobody expects live webhook latency
that isn't there.

## 6. Verification commands (run for every touched package before checking a task off)

```sh
pnpm --filter @molecule/shopify lint typecheck test build
pnpm --filter @molecule/orchestrator lint typecheck test build
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/molecule
export TEST_DATABASE_URL="$DATABASE_URL"
export SHOPIFY_TEST_DATABASE_URL="$DATABASE_URL"
pnpm --filter @molecule/service-reality test
pnpm --filter @molecule/shopify test
pnpm verify:secrets
```
