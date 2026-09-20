# Shopify release adapter

`@molecule/shopify` is a server-only ESM package for Node 22+. It imports runtime
plans, receipts and events from `@molecule/contracts`. The adapter checks the
`VALID` plan schema; it does not certify feasibility. The parent must authorize
execution against its persisted, Python-solver-certified plan and approval.

## Parent wiring

1. Add `@molecule/shopify: workspace:*` to the orchestrator's dependencies and
   regenerate the root lockfile. Neither that manifest nor the lockfile is
   changed in this worker branch.
2. Build contracts, then Shopify. Apply `sql/007_shopify.sql` before constructing
   either provider. The existing DB migrator already discovers numbered SQL
   files, so this migration requires no DB package changes.
3. Inject a shared PostgreSQL pool or use `connectShopifyRepository`. All workers
   for the same stores must share the same database and namespace. Use separate
   namespaces for mock and real modes; do not switch modes over existing data.
4. Replace the orchestrator's local mock with the package factory. Its
   `commit(plan, traceId)` method satisfies the existing orchestrator seam.
5. Only mark execution successful when all required actions succeeded and the
   receipt includes a product, a supplier job for every node, and a customer
   draft. `FAILED` and `PENDING` are partial receipts, not successful checkout.
6. Mount the HTTP-neutral webhook handler with the original request bytes, and
   project persisted adapter events into the parent event feed / marketplace.
   These tables do not automatically insert into the separate Tiger event store.
7. Pass the complete replacement plan to `commit` after offline recovery or an
   intent change. Do not unconditionally cancel every old job first: the adapter
   keeps unchanged jobs and supersedes changed/removed jobs.

```ts
import {
  connectShopifyRepository,
  createShopifyClient,
} from "@molecule/shopify";

const database = connectShopifyRepository(databaseUrl, "shopify-mock");
const shopify = createShopifyClient({
  mode: "mock",
  repository: database.repository,
  // Resolve stable server-side artifact references. Do not pass credentials.
  jobInstructions: (plan, node) => ({
    workOrderRef: `${plan.orderId}/${node.nodeId}`,
  }),
});
const receipt = await shopify.commit(solverCertifiedPlan, traceId);
// At process shutdown:
await database.close();
```

Real construction uses explicitly configured stores:

```ts
const shopify = createShopifyClient({
  mode: "real",
  repository,
  executionEnabled: approvedExecutionEnabled,
  centralStore: {
    domain: centralDomain, // exact *.myshopify.com hostname, no URL
    auth: { accessToken: centralAccessToken },
  },
  supplierStores: {
    "base-goods": {
      domain: goodsDomain,
      auth: { clientId, clientSecret },
    },
    // Configure EVERY merchant appearing in a plan, including backups.
  },
  checkoutHosts: [], // add exact approved custom invoice hosts if needed
  jobInstructions: (_, node) => artifactsForNode(node.nodeId),
});
```

The central and supplier stores must use the plan's currency. Missing supplier
configuration and disabled execution fail before any mutation. Do not fall back
to mock after a live-provider error.

## Public API

Primary classes and interfaces:

```ts
interface ShopifyClient {
  commit(plan: ProductionPlan, traceId: string): Promise<ExecutionReceipt>;
  reconcile(plan: ProductionPlan, traceId: string): Promise<ExecutionReceipt>;
  supersede(
    orderId: string,
    planId: string,
    traceId: string,
  ): Promise<ExecutionReceipt>;
}

interface ShopifyClientOptions {
  repository: ShopifyActionRepository;
  jobInstructions?: (
    plan: ProductionPlan,
    node: ProductionPlan["nodes"][number],
  ) => Record<string, string>;
}
```

- `MockShopifyClient(options: ShopifyClientOptions & MockShopifyOptions)`.
  `MockShopifyOptions.beforeEffect?: (effect: Readonly<ShopifyEffect>) => Promise<void>`
  is a deterministic fault-injection hook.
- `RealShopifyClient(options: ShopifyClientOptions & RealShopifyEffectsOptions)`.
  Real options require `centralStore`, `supplierStores`, and `executionEnabled`;
  `checkoutHosts?: string[]` is optional.
- `createShopifyClient({ mode: "mock" | "real", ...correspondingOptions })`.
- Compatibility aliases: `ShopifyAdapter`, `MockShopifyAdapter`,
  `RealShopifyAdapter`.
- `PostgresShopifyActionRepository(pool: pg.Pool, namespace = "shopify",
lockTimeoutMs = 5000)`.
- `connectShopifyRepository(connectionString, namespace = "shopify")` returns
  `{ repository, close(): Promise<void> }`; its pool uses bounded connection
  and query timeouts. Applications injecting a pool should configure their own
  connection/query timeouts and pool error handling.

The injectable repository interface is:

```ts
interface ShopifyActionRepository {
  withOrder<T>(
    orderId: string,
    run: (journal: OrderJournal) => Promise<T>,
  ): Promise<T>;
  inspect(orderId: string): Promise<ShopifyOrderState | undefined>;
  events(orderId?: string): Promise<MoleculeEvent[]>;
  recordWebhook(
    domain: string,
    deliveryId: string,
    bodyHash: string,
    event: MoleculeEvent,
  ): Promise<"accepted" | "duplicate">;
}
interface OrderJournal {
  load(): Promise<ShopifyOrderState | undefined>;
  save(state: ShopifyOrderState, event: MoleculeEvent): Promise<void>;
}
```

`withOrder` must exclude concurrent workers across the entire callback; `save`
must atomically persist state and its event. An in-memory repository is only
appropriate in tests. The provided PostgreSQL implementation uses a session
advisory lock and separate short transactions for each journal update. It must
connect directly to PostgreSQL or through a **session-pooling** proxy, not a
transaction-pooling proxy. Lock contention can reject after the configured
timeout; retry later with the same plan.

Other exported integration helpers:

- `ShopifyTransport(options: ShopifyTransportOptions)`: `verifyStore()`,
  `listProducts(after?: string)`, `getInventory(inventoryItemId: string)`,
  and schema-validated `graphql(query, variables, schema, mutation = false)`.
  Pagination metadata is returned; do not infer a full catalog from one page.
  Low-level mutations are for trusted adapter code, not public request handlers.
- `ShopifyTransportOptions`: `domain`, `auth`, optional `timeoutMs` (default
  10,000; maximum 60,000), `maxThrottleRetries` (default 2; maximum 3), and injected
  `fetch` for tests.
- `ShopifyAuth`: `{ accessToken: string } | { clientId: string; clientSecret: string }`.
- `SHOPIFY_API_VERSION = "2026-07"`, `shopDomain`, `checkoutUrl`, `adminUrl`.
- `ShopifyError` with sanitized `code`, `uncertain`, and optional known `resource`.
  Persist/report the code; do not log client instances or raw provider responses.
- `verifyWebhookHmac`, `handleShopifyWebhook`, `WebhookOptions`.
- `seedCatalogProduct({ transport, repository, product, traceId, executionEnabled })`
  returns `{ id, actionKey, reused }`.
- Lower-level exports: `ShopifyEffects`, `MockShopifyEffects`,
  `RealShopifyEffects`, `MockShopifyOptions`, `RealShopifyEffectsOptions`,
  `actionTag`, `actionKey`, `digest`, `validatedPlan`, `eventFor`,
  `ResourceSchema` / `ShopifyResource`, `EffectSchema` / `ShopifyEffect`,
  `ActionRecordSchema` / `ActionRecord`, `OrderStateSchema` / `ShopifyOrderState`.

## Effects and recovery

The order's composite product represents the **complete order**, with one
variant priced at `plan.totalCost`, and customer draft quantity **1**. Supplier
drafts similarly contain one work-order line priced at the node's `totalCost`;
the actual production quantity, capability, dependencies and deadline are
custom attributes. This avoids multiplying setup fees by unit quantity or
silently rounding a per-unit price.

Products remain `DRAFT`; no storefront publication is implied. The adapter
creates and updates draft orders only. It never completes an order, sends an
invoice email, captures payment, charges a customer or pays a supplier.

Plans do not currently carry named-recipient lists or logo artifacts.
`jobInstructions` supplies stable artifact references/instructions to the supplier
draft's `molecule_instructions` attribute. Values are limited to 2,000 characters
and the encoded map to 5,000; use access-controlled artifact IDs for large files.
Resolve those references in the supplier work-order UI. Instruction changes
require a new plan ID and participate in job replacement.

Deterministic keys identify product/customer effects by order+plan and supplier
effects by order+plan+node. The full plan plus instructions is fingerprinted:
reusing a plan ID with different content fails. Intent versions cannot regress,
and superseded plans cannot execute again.

Every effect is durably `PENDING` before contacting Shopify. Known rejections
produce `FAILED` actions and can be retried. Timeouts, transport errors, 5xx,
partial GraphQL failures and malformed mutation responses remain `PENDING`.
`reconcile` resumes the same commit: pending effects are looked up by deterministic
handle/action tag or known ID; missing search results do **not** authorize another
create. A search may be eventually consistent. Retry reconciliation later; if
absence cannot be proven, obtain operator/provider confirmation instead of
deleting journal rows or blindly replaying. Recovery never claims transactional
exactly-once delivery across PostgreSQL and Shopify.

Successful mutations retain their Shopify GIDs, variant ID, store, Admin URL,
invoice URL where present, total/currency and tags in the durable action state.
The shared receipt has Admin URL only on `compositeProduct`; customer/supplier
Admin links can be projected from `repository.inspect(orderId).actions`.
No shared-contract change is required for execution. Adding those URLs to the
receipt would require a parent-owned optional contract extension.

An actual Shopify draft total/currency that differs from its approved effect
amount remains `PENDING` with `DRAFT_TOTAL_REQUIRES_REVIEW` and its provider ID.
No checkout success is reported. Taxes/shipping may trigger this check.
`reconcile` can verify a merchant-corrected draft; the parent must route a changed
price through solver/approval rather than manually marking it successful.

Replacement plans update the same composite product and customer draft. Unchanged
nodes keep their draft IDs and receive updated plan metadata. Changed/removed
jobs receive `MOLECULE_SUPERSEDED` and `molecule_superseded_by`; new jobs get new
draft IDs. Superseding marks a draft for merchant workflow—it does not undo work
already performed, delete the draft, or revoke an invoice already shared outside
Molecule. Merchant dispatch/fulfillment must exclude superseded jobs. Completed
drafts are rejected for automated update. Explicit `supersede` returns the
supersession receipt and prevents further commit of that plan. Pending effects
must be reconciled before supersession or a new plan.

The mock performs the same journal transitions. Actual mock resources/effects
are stored in `molecule_shopify_orders.state.mockResources` and survive process
restart. IDs start `gid://molecule-mock/`; mock receipts have no pretend Shopify
Admin/checkout URL. The parent UI must label mock mode and display the receipt
or work-order view instead of a payment link.

## Webhooks

```ts
const result = await handleShopifyWebhook(
  {
    secret: appClientSecret,
    allowedDomains: configuredDomains,
    repository,
    maxBodyBytes: 1_000_000,
  },
  {
    rawBody: originalRequestBytes,
    headers: lowercaseSingleValueHeaders,
  },
);
```

Verify before JSON middleware changes the body. HMAC is SHA-256/base64 over raw
bytes with constant-time comparison. Allowed topics: `inventory_levels/update`,
`products/update`, `draft_orders/update`, `orders/create`, `app/uninstalled`.
Subscriptions are configured by the operator; startup never registers them.
For multiple apps, mount with the correct app secret for each configured store.

Only IDs, inventory availability and normalized envelope fields persist; customer
payloads/email are discarded. Delivery IDs are unique per namespace+domain.
Identical replays return the same event ID and `duplicate`; altered bodies or
topics with the same delivery ID raise `WEBHOOK_REPLAY_CONFLICT`.

Return HTTP 200 after either accepted or duplicate persistence. Map unauthorized
to 401, oversized payloads to 413, invalid/unsupported payloads to 400, and
persistence failures to 503 so Shopify can retry. Consume the persisted events
to invalidate/reload affected catalog facts; ingestion/conflict resolution and
supplier-offline replanning remain parent/Reality responsibilities.

`handleShopifyWebhook` also returns the normalized optional
`X-Shopify-Triggered-At` timestamp. Parents projecting inventory facts should
pass it through as the claim observation time: Shopify does not guarantee
delivery order, so an older delivery must not replace a later inventory fact.

## Environment and scopes

The runtime package does **not** read environment variables or seed on import.
The parent maps its configuration explicitly to the constructor. Keep all
tokens, client secrets and database URLs server-side.

For the supplied CLI scripts:

| Variable                    | Use                                                            |
| --------------------------- | -------------------------------------------------------------- |
| `SHOPIFY_STORES`            | Comma-separated exact shop domains or bare store handles       |
| `SHOPIFY_ACCESS_TOKEN`      | Token for one store; use a separate invocation per token/store |
| `SHOPIFY_CLIENT_ID`         | Installed application client ID, when not using a token        |
| `SHOPIFY_API_SECRET`        | Application client secret (also webhook signing secret)        |
| `SHOPIFY_SEED_ENABLED=true` | Required in addition to `--execute` for seed mutations         |
| `DATABASE_URL`              | Durable seed journal; SQL migration must already be applied    |
| `SHOPIFY_TEST_DATABASE_URL` | Explicit local test DB for integration tests                   |

Client credentials use the documented form-encoded `grant_type=client_credentials`
flow. Shopify limits this flow to apps/stores owned by the same organization;
an app must already be installed. Tokens are cached in server memory until shortly
before expiry. Bring an offline Admin access token for other supported deployment
arrangements. Credential provisioning/storage belongs to the parent's secret
configuration; this package never writes provider tokens to its journal.

Install with `write_products`, `read_products`, `write_draft_orders`,
`read_draft_orders`. Read inventory requires `read_inventory` and location access
(`read_locations`); seeding tracked stock also needs `write_inventory`.
Optional `orders/create` subscriptions require the corresponding order access.
Shopify user permissions and protected-customer-data eligibility can independently
restrict draft fields. Verify actual granted scopes with the read-only script.

All HTTP calls have timeouts, redirects are rejected, shop hosts must be exact
`*.myshopify.com`, and checkout hosts are explicitly allowlisted. Only explicit
throttling without partial data is retried (bounded count and delay). API
fall-forward to a different reported version fails instead of silently changing
the contract.

## Catalog tooling

```sh
pnpm --filter @molecule/contracts build
pnpm --filter @molecule/shopify build
node --env-file=.env scripts/verify-shopify.mjs
node scripts/seed-shopify.mjs --store=basegoods-demo --release --dry
# Only against explicitly authorized development stores:
SHOPIFY_SEED_ENABLED=true node --env-file=.env scripts/seed-shopify.mjs \
  --store=basegoods-demo --release --execute --trace-id=release-catalog-1
```

`--role=basegoods`, `--limit=N`, `--budget=140`, `--store=...`, and `--dry`
remain available. Default mode preserves the broad synthetic catalog.
`--release` selects a small fixed-price acceptance catalog. `--wipe` is rejected:
this release does not perform broad deletion. Every product is visibly labeled
synthetic, tagged `MOLECULE_DEMO`, and remains unpublished.
The central `molecule` store is skipped in release seeding because approved plan
execution creates its composite products.

Seed effects use the same PostgreSQL lock/journal model (namespace `shopify-seed`),
deterministic handles and action tags. Rerunning skips completed matching actions;
uncertain responses reconcile without blind creation. A non-demo product using
the desired handle is not overwritten. Changed/removed action tags yield an
explicit drift error rather than false success.

`scripts/seed-data.mjs` exports `catalogFor`, `releaseCatalogFor`, `roleForStore`,
`MERCHANT_IDS`, `STITCHWORKS_CAPACITY_EVIDENCE`, and `slug`. Both canonical hyphenated
merchant IDs and legacy store prefixes are accepted, including `needle-north`.
The release catalog has cotton hoodie CAD 12, bottle 5, vegan snacks 3, embroidery
4.50/5.10, engraving 3.20 + CAD 35 setup, assembly 2 and fulfillment 2. For 200
units that is CAD 6,375 / 6,495 **before any real-provider tax/shipping change**.
This arithmetic is not a feasibility certificate.

ThreadForge and NeedleNorth each have synthetic 400/day embroidery capacity.
StitchWorks preserves conflicting 100/day web, 50/day document, 20/day fresh-note
evidence; it must not be treated as 100/day verified availability. The solver
must apply the conservative conflict/deadline policy. Parent DB seeds must map
these synthetic facts to canonical capabilities; Shopify seeding does not itself
populate the Reality database.

## Verification and live gaps

Run from the repository root:

```sh
pnpm --filter @molecule/shopify lint
pnpm --filter @molecule/shopify typecheck
pnpm --filter @molecule/shopify build
SHOPIFY_TEST_DATABASE_URL="$LOCAL_TEST_DATABASE_URL" pnpm --filter @molecule/shopify test
pnpm exec prettier --check packages/shopify scripts/seed-shopify.mjs scripts/verify-shopify.mjs scripts/seed-data.mjs docs/SHOPIFY_RELEASE.md
pnpm verify:secrets
```

Tests cover mock persistence, concurrent execution, repeated commits, partial
failures, replacement, artifacts, lost HTTP responses, a failed journal save
after a provider mutation, total-price review, sanitized HTTP errors,
throttling/timeouts/API version, client credentials, HMAC/replay, safe seeding,
and real local PostgreSQL cross-pool locking/reopening/webhook deduplication.
Without `SHOPIFY_TEST_DATABASE_URL`, DB tests are explicitly skipped.

Worker verification passed: 45 Shopify tests including four PostgreSQL tests,
13 contract tests and 36 existing orchestrator tests; package lint, typecheck,
build, scoped Prettier, CLI dry/denied-execution checks and the client-secret
scan. Orchestrator regression tests were run after building its workspace
dependencies.

No Shopify credentials were supplied for this release worker. Deterministic
HTTP provider tests are not live acceptance. Outstanding live checks are:
installation/scopes in every store, client-credentials eligibility, productSet
and draft mutations on 2026-07, actual invoice hosts, tax/shipping totals,
webhook delivery, inventory readback, merchant-side supersession handling and a
human-reviewed draft checkout. No paid checkout or browser UI test was run.

Official references reviewed:

- [productSet](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productSet)
- [ProductVariantSetInput](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/ProductVariantSetInput)
- [draftOrderCreate](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/draftOrderCreate)
- [draftOrderUpdate](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/draftOrderUpdate)
- [draftOrderDelete](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/draftOrderDelete) and [draftOrderComplete](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/draftOrderComplete) (not called)
- [DraftOrder totals](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/DraftOrder)
- [InventoryItem](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryItem)
- [Client credentials](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant)
- [HTTPS webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe/https)
- [API limits](https://shopify.dev/docs/api/usage/limits)

## Catalog mock compatibility entry point

The durable execution API remains at `@molecule/shopify`. The independently
developed per-operation interface is preserved at `@molecule/shopify/catalog`:

```ts
import { MockShopifyAdapter } from "@molecule/shopify/catalog";
const catalog = new MockShopifyAdapter();
const snapshot = await catalog.getSnapshot("stitchworks-7gw6fagb");
```

This entry point exports its own `ShopifyAdapter`, `MockShopifyAdapter`, options,
and provider-specific catalog schemas. It retains snapshot, capacity, catalog,
composite-product, supplier-job, supersession, checkout, inventory-adjustment,
and reset methods. It is an in-memory development fixture, not the durable
orchestrator execution provider; there is no real catalog implementation yet.
No network or credentials are used. Checkout URLs use `shopify-mock.invalid`
and must never be presented as payment links. Unknown capacity is `null`.
The default clock is fixed at 2026-09-19T12:00:00Z; inject `now` when needed.
Reset restores the same seed identifiers, and returned objects are isolated.
Action keys bind to both operation and parsed inputs; conflicting reuse throws
`ACTION_KEY_CONFLICT`. Inventory adjustment/reset are local fixture controls.

Catalog fixtures and CLI seeding share `packages/test-fixtures/src/seed-data.mjs`;
`scripts/seed-data.mjs` preserves the CLI import surface. Existing release
catalogs, canonical supplier aliases, and capacity evidence remain intact.
The Shopify workstream checklists describe historical branch progress and do
not establish completion of their unchecked live-provider roadmap items.
