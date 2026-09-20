# Tiger/Rox release integration

> Status reconciled 2026-09-19: [current database/ROX assessment](DATABASE_ROX.md) is the
> source for current counts, evaluation caveats and priorities. Historical test
> results and incidents below apply only to their recorded revision/environment.

## Entry points

`@molecule/service-reality` exports the database-backed factory. Importing the
package does not start a server.

```ts
import { createRealityService } from "@molecule/service-reality";
import type {
  CandidateCapability,
  ChaosRequest,
  MerchantTwinSummary,
  ProductIntent,
} from "@molecule/contracts";

interface RealityService {
  searchCandidates(
    intent: ProductIntent,
    excludedMerchantIds?: string[],
  ): Promise<CandidateCapability[]>;
  listMerchants(): Promise<MerchantTwinSummary[]>;
  applyChaos(request: ChaosRequest, traceId: string): Promise<void>;
  resetDemo(): Promise<void>;
}

// The optional clock makes candidate deadlines and resolution tests deterministic.
const reality = createRealityService({ now: () => new Date() });
```

Pass the same service into the parent orchestrator's candidate-search, marketplace,
chaos and reset adapters. Search honors exclusions immediately, before chaos is
persisted. Search returns eligible candidates only; `listMerchants()` includes
blocked capabilities and their reasons for the marketplace read model.

Both reads exclude rows marked `merchants.is_placeholder`. Migration
`014_merchant_placeholders.sql` classifies the `m-unresolved` ingestion holding
row without changing its unknown operational status or its artifacts. This also
keeps it out of merchant-agent initialization, which consumes `listMerchants()`.
Genuine merchants remain visible with unknown/offline status or no capabilities.
Entity resolution links artifacts to a real merchant; it does not promote the
shared placeholder into a supplier.

Candidates are proposals, never certified plans. Each capability includes resolved
source claim IDs, remaining capacity after active holds, and p50/p95/p99 historical
risk. Unknown/conflicted prices or capacity do not pass search. Scoped fields such
as `hoodie.material`, `hoodie.color`, and `snacks.diet` apply to the corresponding
goods; global material exclusions apply to goods and transformation ports.
Quantity ranges, currencies and individual capability/p95 deadlines are checked.
The solver must still check complete dependency paths, combined cost and schedule.

Other package exports are `ingestClaim`, `resolveMerchant`, `ResolvedFact`,
`toCanonicalClaim`, `normalizeValue`, `RawClaimInput`, `resolveClaims`,
`explainResolution`, `RESOLUTION_WEIGHTS`, `CONFLICT_MARGIN_THRESHOLD`, and
`realityHealth`.

`ingestClaim(input: RawClaimInput, traceId: string, client?: DbClient)` returns either
`{ ok: true, claim: CanonicalClaim }` or `{ ok: false, reason: string }`, after
transactional persistence. It retains raw JSON/hash/source references and
quarantines invalid numeric values/units. Duplicate artifacts return the original
stored claim, including its original ingestion timestamp.

`resolveMerchant(merchantId, traceId, client, now?)` returns `ResolvedFact[]`;
call this low-level API inside `transaction(client => ...)`. The main factory and
ingestion API already own their transactions. Resolution retains explanation,
scores, winner/loser state and unresolved conflicts. Canonical status claims also
update the merchant read model.

## Configuration and database lifecycle

- `DATABASE_URL`: PostgreSQL connection string; required for database operations.
- `DEMO_MODE=true`: required for seed, reset and every chaos scenario. Chaos also
  rejects merchants without the synthetic demo tag.
- `REALITY_PORT`: optional standalone server port, default `3002`.
- `TEST_DATABASE_URL`: disposable integration database; the integration tests set
  `DATABASE_URL` and enable demo mode themselves.

From the repository root, with environment variables exported:

```sh
pnpm db:migrate
pnpm db:seed
pnpm db:seed
pnpm db:reset
pnpm --filter @molecule/service-reality dev
```

`migrate(): Promise<void>`, `seedDemo(client?): Promise<void>`, and
`resetDemoData(): Promise<void>` are also exported by `@molecule/db`.

The migration runner finds the repository SQL directory from its module location,
sorts numbered files, skips the seed, uses advisory locks, and records checksums in
`molecule_migrations`. It includes parent-owned later migrations automatically.
Applied-file drift is an error. The seed is insert-only and repeatable; it refuses
to overwrite non-demo merchants that collide with the reserved demo IDs. Reset
restores explicit demo capability baselines, demo merchant availability and claims,
releases demo holds, and reverts demo chaos. It preserves other merchants and
retains the event/raw-artifact audit trail. Reset emits an event rather than
deleting historical metrics.

The release-time migration set required TimescaleDB and pgvector: bulk-commerce and
Rox-ingestion migrations use their functions/types directly. Use the CI image
`timescale/timescaledb:2.22.0-pg16` for local acceptance. The older core migrations
have plain PostgreSQL fallbacks, but those do not cover the later bulk/Rox schema.
Later migration-runner changes add optional-Timescale handling for the older bulk
migration; this does not establish that every ROX migration works without pgvector.
Extension availability and errors are queryable through `getDatabaseFeatures`.
Candidate search is currently **lexical** on both paths, including when pgvector
is installed. No embedding provider is called.

## Marketplace, metrics and durable events

Use these `@molecule/db` exports to assemble `MarketplaceSnapshotSchema`:

```ts
getOperationsMetrics(client?: DbClient): Promise<OperationsMetrics>;
getRecentEvents(limit?: number, client?: DbClient): Promise<MoleculeEvent[]>;
getMerchantRisk(merchantId: string, capabilityId: string, client?: DbClient);
getDatabaseFeatures(client?: DbClient);
```

Risk returns `{ p50Hours?, p95Hours?, p99Hours?, sampleCount, confidence }`;
missing history yields no invented percentiles. Database features return
`{ extensions: { name, available, detail }[], candidateSearch: "lexical" }`.
Provider modes/status still come from the parent's adapters.

Metrics count actual `order_sessions` when present, valid plan IDs from
`production_plans`/session JSON, execution receipts or customer-order external
references, active unexpired reservations, persisted conflicts/recoveries/events.
No order rows are manufactured when `order_sessions` is absent. The parent-owned
table is expected to expose `order_id` and `session_json`; session JSON uses
`activePlan.{planId,status}` and
`executionReceipt.customerOrder.{orderGid,draftOrderGid}`.

Durable event APIs:

```ts
interface PersistedEvent { cursor: number; event: MoleculeEvent }

persistEvent(event: MoleculeEvent, client?: DbClient): Promise<PersistedEvent>;
readEvents(
  options?: { afterCursor?: number; orderId?: string; limit?: number },
  client?: DbClient,
): Promise<PersistedEvent[]>;
```

`@molecule/events` exports `appendEvent(event, client?)`, `listEventsForOrder(orderId,
client?)`, `readEvents`, `getRecentEvents`, `PersistedEvent`, and:

```ts
interface SubscriptionOptions {
  afterCursor?: number;
  orderId?: string;
  pollMs?: number;
  onError?: (error: unknown) => void;
}
subscribePersisted(
  listener: (entry: PersistedEvent) => void | Promise<void>,
  options?: SubscriptionOptions,
): Promise<() => void>;
subscribe(
  listener: (event: MoleculeEvent) => void,
  options?: SubscriptionOptions,
): () => void;
```

For SSE, use `readEvents` and resume `subscribePersisted` from the last delivered
cursor. Use the cursor as the SSE ID while keeping the existing event payload.
Await subscription startup and supply an error handler. An omitted `afterCursor`
starts at the current high-water mark; `0` replays history. Polling defaults to
100ms and works across processes. Delivery is at-least-once if a listener fails;
deduplicate by event ID/cursor at consumers.

Events validate against `MoleculeEventSchema`. Identical retries insert once;
reusing an event ID with changed contents throws. Database triggers mirror
committed events into `network_events`, project capacity values into
`market_metrics`, assign monotonic cursors, and publish PostgreSQL notifications.
Transactions acquire the event-order advisory lock before row locks, trading
write concurrency for committed replay ordering. Do not hold application database
transactions open during provider network requests.

## Reservations and chaos

`@molecule/db` exports:

```ts
interface ReserveCapacityInput {
  merchantId: string;
  capabilityId: string;
  orderId: string;
  quantity: number;
  actionKey: string;
  traceId?: string;
  ttlSeconds?: number;
}
reserveCapacity(input: ReserveCapacityInput): Promise<
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: "insufficient_capacity"; available: number }
>;
releaseReservation(reservationId: string, traceId?: string): Promise<void>;
expireReservations(): Promise<number>;
```

TTL defaults to 1,800 seconds and must be an integer in `1..86400`. Pass a trace
ID from the parent; legacy callers fall back to the action key. Holds lock the
merchant/capability and enforce ownership, online status, resolved capacity,
quantity bounds and outstanding holds. Capacity is conservative: a hold consumes
the stated available batch; this API does not promise future scheduling slots.

`ReservationError.code` is `INVALID_REQUEST`, `ACTION_KEY_MISMATCH`,
`INACTIVE_RESERVATION`, `UNKNOWN_CAPABILITY`, `OWNERSHIP_MISMATCH` or `UNAVAILABLE`.
Identical concurrent action keys return the same hold; changed arguments throw;
released/expired holds cannot be revived by retrying an old action key. Call
`expireReservations` on the parent's maintenance interval if expiration events
must appear without new reservation traffic.

All five `ChaosRequest.scenario` values are supported: `supplier_offline`,
`inventory_zero`, `price_spike`, `lead_time_delay`, `conflicting_document`.
Pass an explicit merchant ID for selected-supplier recovery. Action keys derive
from trace/scenario/merchant; retries are idempotent and changed requests with the
same key are rejected. Inventory chaos requires a supply merchant. Price chaos
requires a resolved price; conflict chaos creates two equally authoritative
incompatible price claims. Parent gates requests, calls chaos, then starts
recovery with the selected merchant excluded. Use a fresh trace for a new action
after reset.

## Synthetic acceptance catalog and verification

`kitIntent(now?: Date)` is exported by `@molecule/test-fixtures`. It contains three
desired outputs (`hoodie`, `bottle`, `snacks`) and four transformations:
embroidery, engraving, assembly, fulfillment. Assembly consumes the embroidered
hoodie, engraved bottle and snacks; fulfillment consumes the assembled kit.

The seven synthetic merchants expose eight initially eligible capabilities:
`cap-base-hoodie`, `cap-base-bottle`, `cap-snacks`, `cap-thread-embroidery`,
`cap-needle-embroidery`, `cap-laser-engraving`, `cap-pack-assembly`, and
`cap-pack-fulfillment`. StitchWorks retains its 100/day web, 50/day document and
20/day outage evidence, plus malformed quarantined input. The outage wins;
StitchWorks is excluded for the 200-unit batch. Both backup embroidery merchants
have usable, sourced capacity. Goods include cotton, stainless steel, vegan
snacks, and individual recycled-cardboard packaging.

The primary seven-capability catalog total is CAD 6,395 for 200 kits including
setup fees; Needle North adds CAD 120. This arithmetic is a fixture check, not a
solver feasibility certificate. Every capability has 100 synthetic fulfillment
samples and explicit policy/document provenance.

Verified with actual PostgreSQL 16 and TimescaleDB containers:

```sh
pnpm --filter @molecule/db build
pnpm --filter @molecule/events build
pnpm --filter @molecule/test-fixtures build
pnpm --filter @molecule/service-reality build
pnpm --filter @molecule/db --filter @molecule/events \
  --filter @molecule/test-fixtures --filter @molecule/service-reality lint
pnpm --filter @molecule/db --filter @molecule/events \
  --filter @molecule/test-fixtures --filter @molecule/service-reality typecheck

# Run serially against the same disposable database.
TEST_DATABASE_URL="$DATABASE_URL" pnpm --filter @molecule/db test
TEST_DATABASE_URL="$DATABASE_URL" pnpm --filter @molecule/events test
TEST_DATABASE_URL="$DATABASE_URL" pnpm --filter @molecule/service-reality test
```

Coverage includes rerunnable migrations/seed, migration checksum drift,
concurrent holds, duplicate requests, release/expiry, demo isolation, canonical
resolution/quarantine, all chaos scenarios, global/scoped constraints, risk and
deadlines, event idempotency/rollback/commit order, independent-process replay,
numeric analytics, metrics from real session/plan/execution rows, and Fastify
HTTP injection without import-time listening. Affected source and tests are
formatted; package lint/typecheck/build run through the existing scripts.
Backboard, merchant-agent, orchestrator and OpenAI mock suites and the existing
Python solver suite were also run.

### Historical parent integration handoff (superseded)

The merge verification later recorded integrated adapters, lockfile regeneration
and a passing synthetic full-kit flow. The original handoff below is retained as
history, not current work. Newer acceptance limitations are in DATABASE_ROX.md.

- Regenerate the shared lockfile: Reality adds the workspace fixture dependency.
  This branch intentionally does not edit root configuration, contracts,
  orchestrator files, later SQL migrations or the shared lockfile.
- Wire the factory, metrics and cursor replay into the parent adapters/routes.
- Complete and verify the parent's full-kit solver integration. A direct smoke
  test against base `11e822e` supplied all eight canonical candidates and
  catalog-backed synthetic quotes; that solver returned `UNSAT`. Its
  `services/solver/app/cpsat.py` applies scoped fields to every candidate and
  selects one candidate per capability kind, so it cannot certify this
  multi-supply/multi-transformation kit yet. No constraints were removed and no
  candidate or plan was fabricated to make it pass.
- Final provider and recorded UI acceptance remain with the parent. No live
  Shopify, OpenAI or Backboard credentials were available, and no browser or
  macOS acceptance was run by this worker.
