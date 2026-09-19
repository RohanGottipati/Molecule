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
- Shopify: set `STORAGE_MODE=postgres`, `SHOPIFY_MODE=live`, `REAL_EXECUTION_ENABLED=true`, `SHOPIFY_STOREFRONT_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, and `SHOPIFY_SUPPLIER_STORES`. The supplier setting is a JSON object keyed by merchant ID whose values contain `domain` and `auth: { accessToken }`. The adapter currently targets API version `2026-07`; configuration rejects a different version.

Live paid-provider smoke tests, real voice, production signing/notarization, fresh macOS permission prompts and physical-device interactions require separate acceptance. Automated mocks do not establish those results.

## Recovery and uncertain actions

Supplier-offline chaos is demo-only, restricted to loopback or `CHAOS_SECRET`, and only accepts a supplier in the active plan. Durable chaos changes Reality state before re-planning. Prior supplier jobs are superseded and prior reservations released before replacement work is committed. The solver preserves all hard constraints; an exhausted network enters `NEEDS_HUMAN`.

An action key cannot be reused with changed inputs. PostgreSQL claims prevent different workers from running the same action concurrently; journal receipts survive restart. An interrupted action with no final receipt stays pending rather than automatically repeating an uncertain external mutation. Reconcile its provider action journal and resource IDs before authorizing further work. Do not delete action receipts to force a retry.

Execution that cannot confirm all commerce actions or supplier acceptance enters `NEEDS_HUMAN`. Planning failures retain state and structured events. The service persists project state and supports replay after restart; it does not automatically resume every in-flight planning or external mutation step after process termination.

`COMPLETED` means that the commerce representation and supplier jobs were created and accepted. It does not certify that physical goods have been manufactured or delivered.

## Deployment boundary

The service defaults to loopback for a single operator. Before exposing it to multiple users, place it behind authenticated infrastructure with tenant/order authorization. Provider secrets, chaos controls and ephemeral realtime credentials must stay behind that boundary. The development command is not a public deployment.
