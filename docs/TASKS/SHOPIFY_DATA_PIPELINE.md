# Shopify supplier data pipeline: Shopify -> Tiger DB -> Shopify Admin

Owner: Emaad (Shopify). Written Sat Sep 19 2026. Status tracked in section 9.

Goal: pull all types of supplier data out of the 8 Shopify dev stores, land it in the Tiger Cloud database (the same tables Reality, the solver and the merchant agents already read), and write the results back into Shopify Admin so a judge can see them there. Closing the loop is the demo: edit a supplier's capacity in Admin, the sync turns it into a claim, Reality resolves it, and the plan heals.

## 1. Environment

- Database: Tiger Cloud service `db-37507` (PostgreSQL 18, TimescaleDB 2.30, pgvector 0.8, pgcrypto). Credentials live ONLY in `.env.local` (gitignored) as `DATABASE_URL`. Never commit them, never paste them in chat or docs.
- `.env` still points `DATABASE_URL` at local Docker. Scripts that should hit Tiger run with both files, the later one wins: `node --env-file=.env --env-file=.env.local scripts/<name>.mjs`.
- The URL carries `uselibpqcompat=true&sslmode=require`. Without it `pg` 8.x treats `require` as `verify-full` and rejects Tiger's certificate chain.
- Migrations 001 to 008 and the demo seed (`004_seed.sql`, needs `DEMO_MODE=true`) are applied to Tiger with the same checksum table (`molecule_migrations`) that `pnpm db:migrate` uses, so a teammate running it later sees them as already applied.
- Legacy rows: Tiger already held an early seed from before the integration (merchants `m-basegoods`, `m-customizeco`, `m-customizeco2`, `m-packship`, 4 capabilities, 4 claims). They have status `unknown` and are left untouched. Delete them only after the owner confirms.
- Shopify: 8 dev stores, Admin GraphQL `2026-07`, client-credentials tokens, all stores in CAD.

## 2. Ground rules (from AGENTS.md and the release docs)

1. Facts enter the DB as claims, never as overwrites. Conflicted or unknown stays that way.
2. Only claim what Shopify is authoritative for. Shopify is the live source for capacity and stock. Quoted prices, lead-time semantics and hard rules stay DB-authored, because Shopify tiers price by quantity and states lead time in business days while the DB uses flat CAD and hours. Mixing them would create false conflicts that block planning.
3. A new claim only supersedes an older claim from the same source reference. Reality's resolver scores claims (`0.35*authority + 0.30*recency + 0.25*confidence + 0.10*corroboration`) and declares a conflict when the top two differing values are within 0.08. A fresh Shopify claim at authority 0.95 beats the seeded API claim (0.7) by about 0.10, so it resolves cleanly, but two live claims from the same source would conflict. That is why older same-source claims are marked `superseded`.
4. Idempotent: re-running sync creates nothing new unless a value changed. Writes to Shopify use deterministic identifiers.
5. Synthetic data stays labeled. Every synced product keeps `MOLECULE_DEMO`.

## 3. Data model

New migration `sql/009_shopify_catalog.sql` (additive, never edits an applied file):

| Table                             | Holds                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `shopify_sync_runs`               | one row per run: started/finished, stores, counts, status                                                      |
| `shopify_products`                | store, merchant, product GID, handle, title, type, vendor, status, tags, description, `synced_at`              |
| `shopify_variants`                | variant GID, product GID, SKU, options, price, currency, tracked, `available`, inventory item GID, `synced_at` |
| `shopify_capacity_signals` (view) | tracked "capacity" products with current available units per store                                             |

Existing tables also populated: `merchants` (adds `print-press` if missing), `merchant_stores` (domain per merchant), `raw_artifacts` + `canonical_claims` (capacity claims), `molecule_events` (`reality.claim.ingested`, `shopify.sync.completed`).

Mapping of store handle to merchant ID uses `MERCHANT_IDS` from `packages/test-fixtures/src/seed-data.mjs` (`stitchworks` -> `stitch-works`, and so on).

## 4. Extract (Shopify -> DB): `scripts/shopify-sync.mjs`

1. For each store in `SHOPIFY_STORES`: client-credentials token, then page all products (20 per page, 20 variants each) with tags, type, options, price, SKU, tracked flag and `inventoryQuantity`. Backoff on `THROTTLED`.
2. Upsert `shopify_products` and `shopify_variants` in batches inside one transaction per store. Products that disappeared are marked `status = 'MISSING'`, not deleted.
3. Upsert `merchants` and `merchant_stores`.
4. Capacity claims: for each capability with a capacity-signal product (`STITCH`/`THREAD` embroidery, `LASER` engraving, PackShip assembly and fulfilment), emit `field = <capabilityId>.capacity`, `sourceKind = shopify`, `sourceReference = shopify:<domain>:<inventoryItemGid>`, authority 0.95, confidence 1, `observedAt` = now. Skip if the latest claim for that reference already has the same value; otherwise insert and mark older same-reference claims `superseded`.
5. Log a `shopify.sync.completed` event with counts.
6. Flags: `--dry` (fetch, print summary, no writes), `--store=<handle>`, `--only=claims|catalog`.

## 5. Load results back into Admin: `scripts/shopify-writeback.mjs`

1. Create metafield definitions on `PRODUCT` in namespace `molecule` so values show in Admin: `merchant_id`, `capability_id`, `claim_status`, `resolved_value`, `resolution_source`, `p50_hours`, `p95_hours`, `on_time_rate`, `last_synced_at`.
2. Write to every synced product: `molecule.merchant_id` and `molecule.last_synced_at`, 25 metafields per `metafieldsSet` call.
3. Write to each capacity-signal product: the resolved value and status from `canonical_resolutions` (or the highest-scoring active claim if not resolved yet), plus fulfilment stats from `merchant_risk` (p50, p95, on-time rate from `fulfillment_samples`). This is the "database results reflected in Admin" part.
4. `--reconcile-capacity`: set each capacity-signal item to the DB baseline (`capabilities.capability_json.capacity.available`) where they differ (ThreadForge 180 -> 400, LaserLab 250 -> 400), and create the two missing PackShip signal products (assembly and fulfilment, 600 per day). After that the DB and Shopify agree, so nothing conflicts and any later Admin edit is the only difference.
5. Flags: `--dry`, `--store=<handle>`, `--definitions-only`, `--reconcile-capacity`.

## 6. The self-heal loop this enables

1. Judge opens ThreadForge Admin and sets "Embroidery Capacity - Units per Day" to 0.
2. `node --env-file=.env --env-file=.env.local scripts/shopify-sync.mjs` (or the webhook, once mounted) sees 0, inserts a claim, supersedes the old Shopify claim.
3. Reality resolves `cap-thread-embroidery.capacity` to 0 at the next search, the capability drops out, the solver plans Needle North.
4. Write-back updates the Admin metafields (`resolved_value = 0`, `claim_status = resolved`).
   Automating step 2 (poll every 10s, later the `inventory_levels/update` webhook) is the next milestone, see section 8.

## 7. Verification

- DB: row counts per table, capacity claims per capability, no capability left `conflicted`, `molecule_migrations` lists 009.
- Shopify: query a capacity product and confirm the `molecule.*` metafields and the reconciled quantity; count products per store still equals the seeded count.
- Idempotency: run sync twice, second run inserts 0 claims.
- Loop test: set ThreadForge to 0 through the API, sync, confirm a new claim and superseded old one, then restore 400.
- Secrets: `git status` shows no `.env.local`; `pnpm verify:secrets` passes.

## 8. Open items and risks

- Reality's resolver runs in the Reality service, which cannot run in the cloud VM used for this work. The claims are shaped exactly like `ingestClaim` output, but conflict-free resolution is confirmed by reasoning, not by running the resolver. Run `pnpm verify:kit` or the durable acceptance after pulling.
- No Needle North store exists (it is DB-only) and no capabilities exist for PrintPress. PrintPress data is mirrored and its merchant row is added, but it has no capability so the solver ignores it.
- Webhook mount and a public URL are still needed for push-based sync. Polling is the fallback.
- Draft orders and orders are not mirrored yet. Add them once supplier jobs exist in the stores.
- Scopes: no `write_publications`, `write_files` or `read_customers`. Products stay unpublished with no images.
- The orchestrator's live mode expects static access tokens (`SHOPIFY_SUPPLIER_STORES` JSON). Extend its schema to accept `{clientId, clientSecret}` before flipping `SHOPIFY_MODE=live`.

## 9. Status

- [x] Tiger DB reachable, migrations 001 to 008 and demo seed applied
- [ ] 009 catalog migration applied
- [ ] shopify-sync.mjs (dry run, full run, idempotency)
- [ ] shopify-writeback.mjs (definitions, metafields, reconcile)
- [ ] Loop test and verification
