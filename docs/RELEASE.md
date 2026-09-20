# Molecule operating runbook

## Runtime modes

Copy `.env.example` to `.env`; root development and database commands load it. Shell environment values take precedence. Never commit `.env`.

| Setting                  | Default | Behavior                                                                                                                                  |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_MODE`           | `local` | File-backed project snapshots, contexts, events, action receipts, synthetic catalog and providers                                         |
| `STORAGE_MODE=postgres`  | opt-in  | PostgreSQL sessions, transactional revision/event writes, global event cursors, Reality, Merchant Twins, reservations and Shopify journal |
| `USE_MOCK_OPENAI`        | `true`  | Deterministic compiler and voice simulation                                                                                               |
| `BACKBOARD_MODE`         | `demo`  | Persistent Merchant Twins with synthetic Backboard provider                                                                               |
| `SHOPIFY_MODE`           | `demo`  | Journaled synthetic products, customer drafts and supplier jobs                                                                           |
| `REAL_EXECUTION_ENABLED` | `false` | Live commerce remains disabled                                                                                                            |

Provider availability appears in `GET /api/marketplace` and the web command center. A running Python solver is required in both modes. `VALID` comes only from that solver; supplier quotes and model explanations cannot certify feasibility.

PostgreSQL mode embeds the typed Reality and Merchant Runtime services in the orchestrator process. Separate HTTP processes for those services are not required. Apply migrations before starting it.

## Local and durable startup

Use the README bootstrap. `pnpm dev` starts ports 3000, 3001 and 8000. `WEB_PORT`, `PORT`, `ORCHESTRATOR_URL` and `SOLVER_URL` can override them; adjust URLs together when using custom ports.

`docker compose up -d --wait` starts TimescaleDB/PostgreSQL on loopback with a persistent volume and development-only credentials. Set `MOLECULE_DB_PORT` to use a different database port and update `DATABASE_URL` accordingly. Plain PostgreSQL is supported; the feature read model reports extension availability.

Run `pnpm db:migrate`, `pnpm db:seed`, then `STORAGE_MODE=postgres pnpm dev`. Seed and reset are idempotent and require `DEMO_MODE=true`. Seed does not overwrite live merchant records.

The default local catalog is intentionally synthetic. Its capacity failure history is retained with project events. Use a new `DATA_DIR` for a fresh local demo. Durable mode supports `POST /api/demo/reset` and `pnpm db:reset`; both restore seeded marketplace facts and release synthetic holds while retaining session and action audit history.

## Verification

The root quality gates and both local acceptance scenarios run without paid provider credentials:

```bash
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm solver:lint
pnpm solver:test
pnpm verify:secrets
pnpm verify:desktop
pnpm verify:kit
```

Database adapter tests need a disposable database:

```bash
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/molecule
export TEST_DATABASE_URL="$DATABASE_URL"
export SHOPIFY_TEST_DATABASE_URL="$DATABASE_URL"
pnpm --filter @molecule/db test
pnpm --filter @molecule/events test
pnpm --filter @molecule/service-reality test
pnpm --filter @molecule/merchant-agents test
pnpm --filter @molecule/shopify test
```

The integrated acceptance test needs a separate empty database to keep its schema isolated from existing public tables:

```bash
docker compose exec db createdb -U postgres molecule_runtime_test
ORCHESTRATOR_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/molecule_runtime_test pnpm verify:durable
```

This test creates and removes its own schema, launches a real CP-SAT server on an ephemeral port, and exercises the kit, correction, contexts, approval, supplier replacement, reservation release, duplicate actions, stale approval, restart, SSE cursor replay, and supplier exhaustion. It also verifies that failed revision writes roll back their events and that independent workers cannot claim the same action twice.

The GitHub workflow runs these gates with a TimescaleDB service. Unit tests without the database environment variables intentionally skip database integration suites.

## Live provider configuration

Use dedicated development stores and synthetic customer data first. Credentials remain server-side.

- OpenAI: set `USE_MOCK_OPENAI=false` and `OPENAI_API_KEY`. Model names remain configurable. Real context files use the provider file API; local mock uploads are persisted but their contents are not interpreted by a language model.
- Backboard: set `STORAGE_MODE=postgres`, `BACKBOARD_MODE=live`, and `BACKBOARD_API_KEY`. Identity, threads, documents and memory indexes remain durable. Operational answers are grounded in canonical tools, never in remembered capacity.
- Shopify: set `STORAGE_MODE=postgres`, `SHOPIFY_MODE=live`, `REAL_EXECUTION_ENABLED=true`, `SHOPIFY_STORES`, and `SHOPIFY_STOREFRONT_DOMAIN` (the existing `MOLECULE_STOREFRONT_DOMAIN` alias also works). For stores in the app's organization, existing `SHOPIFY_CLIENT_ID` + `SHOPIFY_API_SECRET` credentials provide renewable tokens; copying a dashboard access token is unnecessary. Known merchant handles in `SHOPIFY_STORES` provide the default supplier mapping; unknown merchants remain unmapped. Optional `SHOPIFY_SUPPLIER_STORES` is JSON keyed by merchant ID, with `domain` and optional `auth: { accessToken }` or `auth: { clientId, clientSecret }`. Omitted supplier auth uses shared app credentials. A static `SHOPIFY_ACCESS_TOKEN` for the storefront remains supported. Ambiguous domains/mappings and conflicting storefront aliases fail before startup effects. The adapter targets API version `2026-07` and rejects a different version.

Durable synthetic startup uses the existing release-demo Shopify fixture, matching
the seeded operational scenario (Thread Forge 400/day). The default standalone
mock and broad catalog retain their separate 180/day fixture. This does not
change any real store's inventory. Durable acceptance no longer patches capacity
inside the test.

`GET /health` checks process liveness. `GET /ready` returns 503 if the solver
health request or PostgreSQL connectivity check fails; it is not certification
that live provider credentials, supplier facts or a production plan are valid.

Live paid-provider smoke tests, real voice, production signing/notarization, fresh macOS permission prompts and physical-device interactions require separate acceptance. Automated mocks do not establish those results.

Backboard live identity writes were exercised with `scripts/verify-backboard.ts --execute` against an isolated local journal and a synthetic merchant. Assistant, document, memory, document-free JSON protocol, advisory canonical quote, and replay identity reuse passed. That is not production quoting of a real merchant.

## Recovery and uncertain actions

Supplier-offline chaos is demo-only, restricted to loopback or `CHAOS_SECRET`, and only accepts a supplier in the active plan. Durable chaos changes Reality state before re-planning. Prior supplier jobs are superseded and prior reservations released before replacement work is committed. The solver preserves all hard constraints; an exhausted network enters `NEEDS_HUMAN`.

An action key cannot be reused with changed inputs. PostgreSQL claims prevent different workers from running the same action concurrently; journal receipts survive restart. An interrupted action with no final receipt stays pending rather than automatically repeating an uncertain external mutation. Reconcile its provider action journal and resource IDs before authorizing further work. Do not delete action receipts to force a retry.

Execution that cannot confirm all commerce actions or supplier acceptance enters `NEEDS_HUMAN`. Planning failures retain state and structured events. The service persists project state and supports replay after restart; it does not automatically resume every in-flight planning or external mutation step after process termination.

`COMPLETED` means that the commerce representation and supplier jobs were created and accepted. It does not certify that physical goods have been manufactured or delivered.

## Deployment boundary

The service defaults to loopback for a single operator. Before exposing it to multiple users, place it behind authenticated infrastructure with tenant/order authorization. Provider secrets, chaos controls and ephemeral realtime credentials must stay behind that boundary. The development command is not a public deployment.

## Shared project read models

Project discovery, accepted original messages, per-order action status, and
execution-aware capabilities are documented in [CONTRACTS.md](CONTRACTS.md#shared-project-discovery-messages-and-action-status).
They use existing session/event/action storage and require no new migration.
Older strict snapshot consumers receive no new snapshot fields.

Use the original message `x-action-id` to query action status after a lost HTTP
response. Keep the same payload and ID until the outcome is known. Do not create
a new key to bypass an unresolved pending/failed receipt. Status reads perform no
provider calls and do not retry work. Receipt completion and message-outcome
events are separate writes; a process termination between them can leave
attention that requires checking both read models. Accepted text and its session
revision are written atomically by LocalStore and PostgresStore.

Recovery search/solver exceptions now leave an explicit failed state, without
overwriting a newer correction. When execution has started, failure does not
enable cancellation or corrections that would discard receipt evidence. If
commerce creation succeeded but supplier acceptance failed, the returned
commerce receipt is retained and the project requires operator reconciliation.
There is no automatic resume/reconcile endpoint. Existing recovery supersession
and reservation ordering is unchanged; these read models do not implement
reservation transfer or a transaction spanning providers.

Original text is retained only for submissions accepted after this change.
Desktop typed corrections need an actual `originalText` value to appear in
message history. Legacy projects can have an empty history while still retaining
their current intent, plan, receipts, and events. Message history responses are
paged, but currently reconstruct outcomes from the order's full event stream.
