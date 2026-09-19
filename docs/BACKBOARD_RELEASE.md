# Backboard release integration

## Parent integration

Use `createMerchantRuntime` from `@molecule/merchant-agents` in the orchestrator.
The runtime needs PostgreSQL even in demo mode; it never silently substitutes
process-local persistence. Apply `sql/001_core.sql` then `sql/006_backboard.sql`
through the existing migration runner. No shared contract changes are required.
Regenerate the shared lockfile after merging: this package adds the workspace
dependency `@molecule/db`. The worker intentionally does not commit the lockfile.

```ts
import { createMerchantRuntime } from "@molecule/merchant-agents";

const merchantRuntime = createMerchantRuntime({
  canonicalData: realityCanonicalClient,
  mode: "demo",
  eventSink: publishPersistedEvent,
});

await merchantRuntime.initialize({
  identity: {
    merchantId: "thread-forge",
    displayName: "Thread Forge",
    specialty: "Embroidery",
    boundaries: ["Use canonical facts for operational decisions."],
  },
  traceId,
  documents: merchantDocuments,
  memories: ["Synthetic demo: confirm approved artwork before execution."],
});

// Existing QuoteRequest/QuoteResponse contracts, including the constraints alias.
const quote = await merchantRuntime.quote(quoteRequest, abortSignal);
const entries = await merchantRuntime.listMemory("thread-forge");

// Record an actual merchant note on its order thread; it survives later orders.
await merchantRuntime.recordMemory({
  merchantId: "thread-forge",
  orderId,
  traceId,
  note: merchantNote,
});
```

`eventSink` receives an event **after its database transaction commits**. Events
are already in `molecule_events`; publish them to SSE/other subscribers without
inserting them again. A sink failure is surfaced to the caller; persisted events
remain available for replay. Capacity/job retries can deliver the same event ID
again, so subscribers must deduplicate by `eventId`. There is no background
delivery worker.

Use the runtime's `mode` and `label` for `MarketplaceSnapshotSchema` provider
status and merchant summaries. Assistant identity, thread identity, documents,
memory, quote requests/responses, intent version, and provider mode are durable.
The provider label is included in events and quote explanations. Demo/live
assistant namespaces are separate so a synthetic assistant ID is never sent to
Backboard.

## Exact exported factory surface

```ts
interface MerchantRuntimeOptions {
  canonicalData: CanonicalDataClient;
  mode?: "demo" | "live";
  backboard?: RealBackboardAdapterConfig;
  eventSink?: (event: MoleculeEvent) => Promise<void> | void;
  quoteTimeoutMs?: number; // default 20_000
  now?: () => Date; // deterministic deadline tests
}

interface InitializeMerchantInput {
  identity: MerchantIdentity;
  traceId: string;
  documents?: MerchantCorpusDocumentInput[];
  memories?: string[];
}

interface RecordMerchantRuntimeMemoryInput {
  merchantId: string;
  orderId: string;
  traceId: string;
  note: string;
}

interface MerchantRuntime {
  readonly mode: "demo" | "live";
  readonly label: string;
  readonly repository: DatabaseMerchantAgentRepository;
  readonly capacity: DatabaseCapacityStore;
  readonly jobs: DatabaseJobDecisionStore;
  initialize(input: InitializeMerchantInput): Promise<MerchantAssistant>;
  ensureOrderThread(input: {
    merchantId: string;
    orderId: string;
    traceId: string;
  }): Promise<OrderThread>;
  recordMemory(
    input: RecordMerchantRuntimeMemoryInput,
  ): Promise<MerchantMemoryCardEntry>;
  quote(request: QuoteRequest, signal?: AbortSignal): Promise<QuoteResponse>;
  listMemory(merchantId: string): Promise<MerchantMemoryCardEntry[]>;
  retrieveDocuments(
    merchantId: string,
    query: string,
    depth?: number,
  ): Promise<RetrievedDocumentChunk[]>;
  health(): Promise<{
    mode: "demo" | "live";
    label: string;
    database: "ready";
  }>;
  close(): Promise<void>;
}
```

Also exported:

- `DatabaseMerchantAgentRepository(mode, db = getPool())` implements the existing
  Backboard `MerchantAgentRepository`, plus `listMemory`, `saveMemory`,
  `listIndexedDocuments`, and an optional content argument on `saveDocument`.
- `DatabaseCapacityStore(eventSink?)` implements `CapacityStore`.
- `DatabaseJobDecisionStore(eventSink?)` implements `JobDecisionStore`.
- `DatabaseCanonicalDataClient` implements `CanonicalDataClient` against the
  existing capabilities/claims tables.
- `MerchantEventSink`, `MerchantProviderMode`, and the factory/input interfaces
  above are exported as types.

Use runtime lifecycle methods for identity creation: they serialize concurrent
initialization/thread creation across processes with PostgreSQL advisory locks.
The low-level repository's `save*` methods are persistence primitives and do not
independently create provider resources or publish lifecycle events.

`close()` aborts pending runtime requests and prevents new requests. It does not
close the shared `@molecule/db` pool; the owning application calls `closePool()`
after all services have stopped. Configure `DATABASE_URL` before constructing
the runtime. A separate pool option is intentionally absent because existing
database services share the singleton.

## Canonical grounding and acceptance boundaries

Both modes call `get_capability_policy`, `get_canonical_claims`, `get_capacity`,
and `calculate_quote`; supply capabilities also call `get_inventory`.
Prices and setup fees come from canonical capability data. Missing price,
missing capacity, unresolved relevant evidence, unsupported constraints,
insufficient stock/capacity, or a missed deadline cannot produce `CAN_ACCEPT`.
Canonical conflicts remain conflicts; document text and remembered notes cannot
override operational tools. Live model output passes the same canonical gate.
The model cannot change merchant/order context or query a different capability.
Only read tools are offered during runtime quotes.

The injected `CanonicalDataClient` must:

- Return validated, current capabilities owned by the requested merchant, with
  explicit price, setup fee, capacity, lead time, and policy hard rules.
- Return all merchant claims when `fields=[]`, including unresolved and
  superseded evidence. Referenced `sourceClaimIds` must exist and be active.
- Reflect outages in canonical capacity/availability, not only in a memory note.
  Active numeric `capacity`, `capacity.available`, and `capacity_per_day` claims
  also block quotes above their value. Active `offline=true` or `available=false`
  marks a merchant unavailable.
- Return supply inventory by the first produced port's explicit `attributes.sku`
  when present; otherwise the capability ID is the SKU.
- Identify component scope with produced port `name`, `kind`,
  `attributes.product`, or `attributes.outputId` (`hoodie`, `bottle`, `snacks`).
  Scoped constraints apply to matching outputs. Global material/color/diet
  restrictions apply to supplied goods. A merchant hard rule without verifiable
  input facts causes a decline.

`DatabaseCanonicalDataClient` reads stock from an active numeric claim named
`inventory.<sku>`. The parent can inject its Reality adapter instead if inventory
uses a different representation. It must seed the **same capability IDs and
capacity values** in PostgreSQL because availability subtracts held reservations
from `capabilities.capability_json.capacity.available`.

Quotes conservatively require the quantity to fit current unreserved capacity.
They do not multiply daily capacity by days remaining. Lead-time estimates use
the canonical maximum; `business_hours` uses eight-hour weekdays with weekends
excluded. Holiday/cutoff calendars and DAG scheduling belong to the solver.
Only the Python solver certifies the complete plan and CAD 7,000 budget.

The parent owns the seven-merchant demo catalog and end-to-end solver scenario.
Preserve StitchWorks' 100/day website, 50/day document, and fresh 20/day outage
evidence with truthful resolution states. Seed verified backup capacity in
Reality and the DB; don't claim 200 units fit the 20/day merchant. This runtime
does not overwrite that evidence or populate a competing merchant catalog.

`hardConstraints` and legacy `constraints` are merged by `QuoteRequestSchema`.
`intentVersion` is stored on every quote and included in its event. Parent
orchestrator must discard a response whose request version is no longer current;
the runtime does not own global intent-version ordering.

### Approved execution

Runtime `quote` is always advisory, including a request with `hold=true`.
It never reserves capacity or accepts jobs. Reserve only after approval:

```ts
const reservation = await merchantRuntime.capacity.reserve({
  merchantId,
  capabilityId,
  orderId,
  quantity,
  traceId,
  actionKey: `approved:${orderId}:${intentVersion}:${nodeId}:reserve`,
});
await merchantRuntime.jobs.acceptJob({
  merchantId,
  orderId,
  nodeId,
  eta,
  traceId,
  actionKey: `approved:${orderId}:${intentVersion}:${nodeId}:accept`,
});
```

Database effect methods reject missing `traceId`/`actionKey`, nonpositive or
noninteger reservation quantities, and reuse of an action key with different
input. Capacity rows serialize reservations, counting active unexpired holds;
holds expire after 30 minutes. The store writes the existing `reservations`
table, so it interoperates with `@molecule/db` reservation APIs. Reservation,
action record, and event writes commit together on one connection. Job decisions
and events also commit together; ETA changes require an accepted job.
`release`, `declineJob`, and `updateEta` expose the existing typed store methods.
Approval authorization and Shopify execution remain the orchestrator's job.

Legacy `createQuoteService` retains its explicit held-quote behavior for existing
consumers/tests. Use **the runtime factory** for the integrated advisory API.
Existing model router, optional three-perspective council, mock adapter,
repository, and quote-service exports remain available.

## Provider configuration and failure behavior

Omit `mode` and `backboard` for deterministic synthetic demo operation.
Explicit `mode: "live"` requires `backboard`; supplying `backboard` with no mode
also selects live. `mode: "demo"` never contacts Backboard.

```ts
backboard: {
  apiKey: serverSideSecret,
  baseUrl: "https://app.backboard.io/api", // default
  defaultModel: "gpt-4o",                // default
  defaultProvider: "openai",            // default
  requestTimeoutMs: 15_000,             // default
  fetchImpl,                           // optional deterministic provider tests
  signal,                              // optional adapter-level cancellation
}
```

No keys or provider error bodies are logged. Provider responses are validated
before use; invalid JSON, missing IDs, wrong-thread responses and malformed tool
calls cannot become successful quotes. `BackboardApiError` exposes `status` and
`code` (`HTTP`, `TIMEOUT`, `ABORTED`, `INVALID_RESPONSE`, `NETWORK`). Runtime quote
failures surface `MerchantQuoteUnavailableError` or `QuoteProtocolError`.
Cancellation and timeout are reported as unavailable (`TIMEOUT`); there is no
live-to-demo fallback. Abort signals reach live fetch requests. Canonical tool
promises are bounded even when an injected client ignores cancellation; late
results cannot persist a completed quote.

Canonical grounding, pooled assistant/memory reads, model selection and provider
quote/tool calls run outside the quote write transaction. The completed response
and buffered model-selection/quote events are persisted together in a short
transaction; only that transaction checks out its database client. Merchant
transactions acquire Tiger's global event cursor lock `73481203` before resource
advisory locks or row/FK locks, matching `@molecule/db.transaction` and the event
cursor trigger. Do not call injected canonical clients or provider quote APIs
from a transaction callback: Reality reads may acquire their own connection and
transaction.

Explicit quote `actionKey` retries return the stored response without invoking
canonical/provider calls. Concurrent retries publish one quote and one event set;
reuse with a different parsed request (including identity, intent version, or
trace ID) or mode fails. The first committed response is immutable. Use a new
action key for a fresh quote after canonical facts change. Requests without an
explicit key retain the request/response-derived key and freshly ground facts.
Cancellation is rechecked after lock acquisition and before commit, so a quote
cancelled while waiting to persist cannot create a completion record or event.

Official references audited before any provider mutations:

- [Create assistant](https://backboard-docs.docsalot.dev/api-reference/assistants/create.md)
- [Create thread](https://backboard-docs.docsalot.dev/api-reference/assistants/create-thread.md)
- [Send message](https://backboard-docs.docsalot.dev/api-reference/threads/send-message.md)
- [Submit tool outputs](https://backboard-docs.docsalot.dev/api-reference/threads/submit-tool-outputs-simple.md)
- [Upload document](https://backboard-docs.docsalot.dev/api-reference/assistants/upload-document.md)
- [Add memory](https://backboard-docs.docsalot.dev/api-reference/memories/add.md)
- [List memories](https://backboard-docs.docsalot.dev/api-reference/memories/list.md)
- [List models](https://backboard-docs.docsalot.dev/api-reference/models/list.md)

The adapter uses JSON messages and simplified thread tool-output submission,
multipart document upload, `X-API-Key`, and actual Zod-generated function
parameter schemas. Tool arguments are validated locally and server identity
is authoritative.

### Honest live acceptance gaps

No live credentials were supplied. Provider tests use mock fetch; external
assistant creation, models, document processing and provider memory remain
unverified. Add-memory's documented response is an open object; Molecule
requires a nonempty `id`/`memory_id` and valid `created_at` to persist provenance.
List-memory permits absent/null timestamps in the provider schema; the adapter
fails visibly rather than inventing a historical timestamp in that case.

Backboard has no independent document-search endpoint matching the existing
chunk/provenance interface. The real adapter keeps that operation unsupported.
Runtime `retrieveDocuments` searches the **local durable uploaded-text mirror**,
preserving file/category/version/source timestamp/stale status. It is not a
claim that remote RAG processing completed. Increment document version when
content changes. Retrieved text is never canonical operational truth.

Database locks and uniqueness protect concurrent/repeated successful lifecycle
operations. An external create request that succeeded immediately before a
process/DB failure may leave an orphan provider resource: official create APIs
do not document an idempotency key or atomic DB/provider transaction. This
cannot be certified exactly-once without live reconciliation support.

## Standalone HTTP service

The parent can run entirely in process. Optional service:

```sh
pnpm --filter @molecule/merchant-agents... build
DATABASE_URL=... MERCHANT_PROVIDER_MODE=demo \
  pnpm --filter @molecule/merchant-agents start
```

Bind address is loopback; `MERCHANT_AGENTS_PORT` defaults to `3002`.
`MERCHANT_PROVIDER_MODE=live` requires server-side `BACKBOARD_API_KEY`.
Startup initializes identities for existing merchants; catalog, inventory and
policy remain canonical DB/Reality responsibilities.

- `GET /health`: DB migration readiness and provider mode/label.
- `POST /api/merchant-agents/:merchantId/quote`: path identity wins.
- `GET /api/merchant-agents/:merchantId/memory`: sanitized durable entries.
- Default body limit: 256 KiB; oversized bodies return 413.
- Default request limit: 30 seconds; request timeout returns 408.
- Invalid JSON/escaped URLs/schema input returns 400; provider unavailable 504;
  invalid provider quote 502; other failures 500 with sanitized messages.

`createMerchantAgentsServer` accepts optional `maxBodyBytes`, `requestTimeoutMs`,
and `health` dependencies. No authentication is added to this loopback internal
service; the parent should expose it only through its authenticated API.

## Verification

```sh
pnpm --filter @molecule/backboard... build
pnpm --filter @molecule/merchant-agents... build
pnpm --filter @molecule/backboard lint
pnpm --filter @molecule/backboard typecheck
pnpm --filter @molecule/backboard test
pnpm --filter @molecule/merchant-agents lint
pnpm --filter @molecule/merchant-agents typecheck
DATABASE_URL=postgresql://... pnpm --filter @molecule/merchant-agents test
```

Database tests create a unique temporary PostgreSQL schema, apply migrations 001
and 006, and drop their own schema after finishing. They need a local test DB
role allowed to create schemas/extensions. Without `DATABASE_URL` only those
database tests are skipped. The release verification used real PostgreSQL 16,
including a separate Node process reading persisted memory.
Run the direct filtered command for DB acceptance: the root Turbo task currently
filters `DATABASE_URL` out of its child environment.

Tests cover provider HTTP errors/timeouts/abort, malformed responses and wrong
thread identity, typed tool schemas, HTTP request limits, repeated identities,
concurrent order threads, cross-order/process memory, retained document
provenance, canonical conflicts, 100/50/20 history versus verified backup,
constraint aliases, intent version, non-reservation, idempotent/concurrent
capacity and jobs, and rejection of live model mutation/identity-switch tools.
Browser UI acceptance belongs to the parent session.

The concurrency regression mirrors Tiger's event cursor trigger and canonical
read lock order. Eight simultaneous quotes complete on a two-connection pool.
Separate regressions cover global-before-resource locking, immutable concurrent
quote retries/collisions, cancellation during the persistence lock wait, and no
checked-out connection or global lock during live quote provider calls. The
pool/lock-order/retry regressions fail on worker commit `a054de8`.

Release worker checks also passed root build/lint/typecheck/tests, solver
lint/typecheck and nine solver tests, `verify:desktop` (real CP-SAT with provider
mocks), and `verify:secrets`. Changed files pass Prettier. Root `pnpm format`
reports 16 unchanged baseline files at integration commit `11e822e` (including
shared documentation/lockfile, Reality, DB and two existing Backboard files);
the worker leaves these existing formatting differences to the parent.
