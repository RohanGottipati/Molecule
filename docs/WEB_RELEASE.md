# Molecule OS web release

## Ownership and integration

This change is scoped to `apps/web/**` and this document. It starts at integration
commit `11e822ed36796b1c91c77f01f7f147921cd3fe5e`, not main. No dependencies, shared
schemas, root configuration, lockfile, provider adapters, solver or orchestrator
implementation were changed. Parent owns the final integration and PR.

The app has five URL-addressable workspaces:

- Command Center: the brief, confirmed state, production dependency graph,
  solver results and recorded activity.
- Merchant Twins: actual capabilities, pricing, capacity, blocked reasons, source
  claim references, sanitized memory, policies and documents.
- Reality & evidence: source facts, observation/ingestion dates, extraction
  confidence, source authority and unresolved resolution states.
- Operations: persisted counts, provider mode/health and event activity.
- Execution: current-plan approval, action receipts, provider references and
  safe commerce links, plus demo supplier-offline recovery.

`/` is an empty workspace. It does **not** create an order on mount. Sending the
first brief explicitly creates one, writes `/projects/<orderId>` to browser
history, then submits the brief. Refresh/deep links GET that existing order.
New project returns to the empty workspace; no order is created until submission.
`?view=merchants|reality|operations|execution` selects a workspace. Back/forward
restores both project and workspace. There are no fictitious project-history
rows: the backend exposes no list-of-projects endpoint.

## Server configuration

Run the web app as a Next Node server. `apps/web/app/api/[...path]/route.ts` is a
dynamic streaming proxy, so this application cannot be deployed as a static
export.

Set **server-only** `ORCHESTRATOR_URL` if the backend is not at the default
`http://127.0.0.1:3001`. The browser uses only relative `/api/...` URLs. Remove any
old deployment dependency on `NEXT_PUBLIC_ORCHESTRATOR_URL`; it is not read.
No browser-side OpenAI connection or realtime client-secret endpoint is used.
Voice displays an explicit unavailable state; text is the supported input.

The proxy allows only the routes listed below, forwards only content/action/trace
metadata and SSE replay headers, and drops browser cookies, authorization,
provider cookies and client-supplied chaos secrets. Mutations reject cross-site
requests and compare Origin against the request/forwarded host. The deployment
proxy must set `x-forwarded-host` to the actual user-facing host rather than trust
arbitrary incoming values. No provider or application credentials should be put
in `NEXT_PUBLIC_*` values.

The browser request deadline is 120 seconds; upstream header/non-stream response
deadline is 125 seconds. SSE continues beyond that deadline after its headers are
received. Browser disconnect cancellation propagates through the proxy. Bodies
are capped at the canonical `MAX_CONTEXT_BYTES` (10 MiB), including chunked
uploads. SSE responses have `Cache-Control: no-store, no-transform` and
`X-Accel-Buffering: no`; disable reverse-proxy SSE buffering as well.

## Endpoint expectations

| Method and route                 | Request / canonical response                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/marketplace`           | `MarketplaceSnapshotSchema`; provider modes, merchant twins, operations metrics and recent persisted events  |
| `GET /api/desktop/config`        | Existing `{ demoMode: boolean, ... }`; fail closed when missing or malformed                                 |
| `POST /api/orders`               | JSON `{}`; `OrderSessionSnapshotSchema`                                                                      |
| `GET /api/orders/:id`            | `OrderSessionSnapshotSchema`                                                                                 |
| `POST /api/orders/:id/messages`  | Existing text, locale, timeZone, assets and optional correction; `OrderSessionSnapshotSchema`                |
| `POST /api/orders/:id/approve`   | `{ planId, intentVersion }`; `OrderSessionSnapshotSchema`                                                    |
| `GET /api/orders/:id/events`     | Native EventSource, named `molecule` events with `MoleculeEventSchema`, named `ready` event, SSE `id` cursor |
| `GET /api/projects/:id`          | `DesktopResultSchema`, including persisted attached asset references                                         |
| `POST /api/projects/:id/context` | Raw bytes, `x-action-id`, encoded `x-file-name`, `x-file-type`; `ContextReceiptSchema`                       |
| `POST /api/projects/:id/actions` | Canonical `DesktopActionSchema` with `attach_context`; `DesktopResultSchema`                                 |
| `POST /api/chaos`                | Existing supplier-offline `{ scenario, orderId, merchantId, actionId }`; `OrderSessionSnapshotSchema`        |

Only contract schemas validate domain responses. `demoMode` is checked as the
existing small configuration object; no competing domain schema was introduced.
Non-2xx responses and malformed success bodies surface as errors. There is no
fallback mock success, invented merchant data or synthesized metrics.

Context uploads accept canonical PNG/JPEG/PDF/CSV/text/JSON types and enforce size
and filename restrictions before hashing or sending bytes. The backend still
owns MIME/content verification. Upload is followed by canonical `attach_context`.
The UI lists an attachment only after that action succeeds. After attaching,
send a new message to recompile with it. Messages pass an empty assets array so
the existing server merges persisted attached contexts; the browser never claims
to interpret logo images or bottle names itself.

### Identities and stale-result handling

Every mutation includes `x-trace-id`, `x-action-id` and `x-action-key`. Keys are:

- Creation: a generated operation ID retained for this explicit creation attempt.
- Message: `message:<orderId>:<intentVersion>:<SHA-256(trimmed text)>`.
- Approval: `approve:<orderId>:<planId>`.
- Upload: `upload:<orderId>:<SHA-256(name, MIME type, file checksum)>`.
- Attachment: `attach:<contextId>`.
- Offline: `offline:<orderId>:<planId>:<merchantId>` (also sent as `actionId`).

The pending-operation guard prevents duplicate clicks and React effect replay
does not create projects. No mutation is automatically retried on timeout.
Timeout/error wording asks the user to refresh the server outcome.

Snapshots cannot replace a different active project or regress revision, intent
version, plan generation or event cursor. Every SSE payload is parsed with
`MoleculeEventSchema`, checked against the active order, and deduplicated by
`eventId`. Reconnects retain the EventSource replay cursor; duplicate persisted
events cannot duplicate UI rows. Snapshot refreshes are debounced. A disconnected
or invalid stream polls snapshots every ten seconds, and manual refresh is
available. Raw event payloads are not dumped into the UI.

## Exported interfaces

- `OrderWorkspace({ initialOrderId?: string })`: root and existing project route
  entry component.
- `PlanGraph({ plan, previousPlan, merchants, candidates, offlineMerchants,
onSelect })`: all domain props use contract types; node selection supplies
  `ProductionPlan["nodes"][number]`. Layout uses graph dependency depth and
  separates component branches. Offline/replaced historical nodes remain visible
  during the current visit. Only real solver edges are drawn.
- `useWorkspace(initialOrderId?)`: project state/actions, marketplace,
  attached contexts, server event stream and URL navigation.
- API helpers: `createOrder(actionKey)`, `getOrder(orderId, signal?)`,
  `getMarketplace(signal?)`, `getDemoMode(signal?)`,
  `submitMessage(order, text, actionKey, assets?, correction?)`,
  `approvePlan(order)`, `triggerChaos(order, merchantId, scenario, actionKey)`,
  `uploadContext(order, file, actionKey)`, `getContexts(orderId, signal?)`.
  The order mutations/read return `Promise<OrderSessionSnapshot>`, marketplace
  returns `Promise<MarketplaceSnapshot>`, demo mode returns `Promise<boolean>`,
  and context upload/read return `Promise<DesktopResult>`.
- Supporting API exports: `request(path: string, init?: RequestInit):
Promise<unknown>`, `actionHeaders(traceId: string, actionKey: string)`,
  `fileMetadata(file: File, actionId: string)` (canonical `ContextUpload`), and
  `RequestError(message: string, status: number, code: string, traceId?: string)`.
- `proxyRequest(request, segments, backend?)`: server-only allowlisted proxy.
  The explicit backend argument is for local integration tests.
- Shared panels: `Badge`, `Empty`, `EventList`, `ClaimTable`, `MerchantDetail`,
  `MerchantsView`, `RealityView`, `OperationsView`, `ExecutionView`, `NodeDetail`.
  Props are inline typed in `apps/web/components/WorkspacePanels.tsx`.
  `VoiceControl()` renders the unavailable label and needs no props.
- Pure helpers: `mergeSnapshot`, `parseEvent`, `mergeEvents`, `mergeContexts`,
  `graphPositions`, `planDelta`, `safeHref`, `supplierAdminUrl`, `parseView`,
  `money`, `dateLabel`, `humanize`, `displayValue`, `stateLabels`,
  `processingStates`, `views` and `WorkspaceView`.
- UI state types: `ConversationEntry = { id: string; text: string;
status: "sending" | "confirmed" | "unconfirmed" }` and
  `Connection = "idle" | "connecting" | "connected" | "reconnecting" | "invalid"`.

## Parent wiring and honest acceptance gaps

1. **Marketplace:** base `11e822e` defines `MarketplaceSnapshotSchema` but does not
   register `GET /api/marketplace`. Parent must wire that route with actual data.
   Until then the web shows a visible marketplace error, not seeded substitutes.
   Return `mode: demo` for synthetic seed data and report each provider's actual
   mode/status. Hybrid deployments show individual provider modes in Operations.
2. **Durable mutation idempotency:** at this base, `/api/orders` creation and
   `/api/orders/:id/messages` do not consume the action headers. The web avoids
   duplicate mount/click submissions and sends stable operation keys, but only a
   parent-owned server action ledger can guarantee retries across timeout,
   browser reload or network loss do not duplicate effects. Approve must remain
   plan/version checked and commerce adapters must keep deterministic keys.
3. **Quote inputs:** the browser never constructs a `CurrentQuoteRequest`.
   Parent must merge current hard constraints, deadline, quantity, currency and
   context in server-side quote fan-out, as required by the release contract.
4. **Chaos:** only `supplier_offline` is accepted by the base server handler.
   Other canonical scenarios are explicitly described as unavailable. Do not
   enable them in UI without a server implementation and advertised capability.
   Demo mode is fail-closed, and backend authorization remains enforced.
   The default local backend satisfies the existing localhost check. Remote
   deployments that require `CHAOS_SECRET` need parent-owned secure server
   authorization wiring; this proxy deliberately never forwards client secrets.
5. **History:** user message text is not exposed by snapshots or current events.
   This visit's conversation labels responses as confirmed/unconfirmed; refresh
   restores the compiled brief, attached assets and persisted event ledger.
   A cross-visit text transcript needs a canonical backend read model. Historical
   plan snapshots are also absent: replaced-node geometry and exact completion
   hour deltas are available for plans observed in this visit. Persisted recovery
   events restore matching-plan cost delta and deadline-preserved status after
   refresh. No missing historical quote or completion date is guessed.
6. **Voice:** unavailable in this web release. A future implementation requires
   a separately reviewed credential boundary; no direct realtime browser
   endpoint is shipped.
7. **Live acceptance:** no credentials were provided, no external provider
   mutations were performed and no live-provider success is claimed. The parent
   must validate the fully integrated 200-kit request, “No polyester”, selected
   embroidery merchant outage, replacement plan and commerce receipts. The
   parent also owns final recorded browser acceptance and responsive/accessibility
   interaction review; this worker intentionally did not run browser testing.

## Verification

Commands are run from the repository root:

```sh
pnpm exec prettier --write apps/web/app apps/web/components apps/web/lib docs/WEB_RELEASE.md
pnpm exec prettier --check apps/web/app apps/web/components apps/web/lib docs/WEB_RELEASE.md
pnpm --filter @molecule/web lint
pnpm --filter @molecule/web typecheck
pnpm --filter @molecule/web test
pnpm --filter @molecule/contracts build
pnpm --filter @molecule/openai build
pnpm --filter @molecule/openai test
pnpm --filter @molecule/orchestrator test
pnpm --filter @molecule/web build
pnpm verify:secrets
```

Web tests cover stale snapshots, foreign/malformed/deduplicated event replay,
branching/cyclic graph layout, valid-plan recovery deltas, safe provider links,
canonical API response validation, explicit creation metadata, timeout behavior,
file boundaries, upload/attach sequencing and failure propagation. Proxy tests
use a real local HTTP server to verify forwarding, credential stripping,
cross-site rejection, route traversal rejection, upload limits, non-success
preservation and immediate SSE streaming with replay cursors. Provider tests use
the existing deterministic mocks. Browser acceptance remains intentionally
delegated to the parent.

Verified on this branch:

- Formatting check, web lint and web typecheck passed.
- Web unit/local-HTTP integration suite: 33 tests passed across 3 files.
- Existing OpenAI mock suite: 30 tests passed across 4 files.
- Existing orchestrator suite: 36 tests passed across 6 files, including desktop
  context/action/SSE persistence tests.
- Contracts and OpenAI builds passed; optimized Next production build passed.
- Client-secret source/bundle scan passed. Browser static bundles contain no
  `ORCHESTRATOR_URL`, backend loopback URL or direct OpenAI/realtime endpoint.
- No browser testing, credentialed provider calls or separate PostgreSQL
  acceptance was performed for this web-only change.
