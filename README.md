# Molecule OS

> Say what should exist. Molecule assembles a company to make it.

Molecule OS is a contract-first marketplace orchestrator. It compiles a customer request into a typed intent, resolves merchant capabilities from evidence, requests quotes from persistent merchant agents, validates a production graph with a deterministic solver, and commits the resulting commerce actions through idempotent provider adapters.

The repository was initialized from the **Molecule OS AI-Agent-Optimized Implementation Playbook** ([`docs/Molecule_OS_AI_Agent_Implementation_Playbook.docx`](docs/Molecule_OS_AI_Agent_Implementation_Playbook.docx), also exported as [`Molecule_OS_AI_Agent_Implementation_Playbook.pdf`](Molecule_OS_AI_Agent_Implementation_Playbook.pdf)) and built for Hack the North — see the [track dossier](docs/HACK_THE_NORTH_TRACKS.md).

## Features

- **Brief → intent:** an OpenAI compiler (or a deterministic mock) turns free text, voice-derived text, and attached context into a schema-valid `ProductIntent`, asking clarification questions when needed.
- **Evidence-backed discovery:** the Reality service resolves canonical merchant facts with provenance and risk; unknown or conflicted facts stay unknown or conflicted.
- **Merchant Twins:** Backboard-backed merchant agents return typed quotes.
- **Deterministic feasibility:** only the Python OR-Tools CP-SAT solver can mark a plan `VALID` or `UNSAT`.
- **Approval, execution and recovery:** approved plans run through the Shopify adapter with `traceId`/`actionKey` idempotency; supplier-offline recovery replans while keeping every component and constraint.
- **Event-sourced UI:** every meaningful transition is persisted as a `MoleculeEvent` and streamed to the web command center over SSE.
- **Two surfaces:** a Next.js command center and a macOS-oriented Electron voice/context overlay.
- **Two storage modes:** file-backed local mode (default) and a durable PostgreSQL/TimescaleDB mode. Provider modes are displayed explicitly; the default demonstration creates synthetic commerce records without charging anyone.

## Tech stack

| Area            | Technology                                                        |
| --------------- | ----------------------------------------------------------------- |
| Monorepo        | pnpm workspaces, Turborepo, TypeScript                            |
| Web             | Next.js 16, React 19, React Flow (`@xyflow/react`)                |
| Desktop         | Electron, React, Vite                                             |
| Services        | Node.js, Fastify, Zod                                             |
| Solver          | Python 3.12, FastAPI, OR-Tools CP-SAT, NetworkX, Pydantic         |
| Data            | PostgreSQL / TimescaleDB (Tiger Data), SQL migrations in `sql/`   |
| Providers       | OpenAI, Backboard, Shopify Admin API (each with a mock/demo mode) |
| Tests / quality | Vitest, `node --test`, pytest, ruff, mypy, Prettier               |

## Architecture

```text
Web -> Orchestrator -> OpenAI compiler -> ProductIntent
                     -> Reality/Tiger -> candidates + provenance
                     -> Merchant Agents/Backboard -> quotes
                     -> Solver -> VALID | UNSAT
                     -> Shopify -> products, customer order, supplier jobs
                     -> Tiger events -> SSE -> Web
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/CONTRACTS.md`](docs/CONTRACTS.md). In PostgreSQL mode the orchestrator embeds the Reality and Merchant Runtime services, so separate HTTP processes are not required.

### Repository map

```text
apps/web                 Customer command center and production graph (Next.js)
apps/desktop             macOS Electron voice/context overlay
apps/shopify-app         Shopify-side documentation (status, changelog, strategy)
services/orchestrator    Workflow, actions, state machine, and SSE (port 3001)
services/solver          Deterministic Python CP-SAT solver (port 8000)
services/merchant-agents Backboard Merchant Twins
services/reality         Canonical claims and candidate search
packages/contracts       Shared runtime-validated (Zod) contracts
packages/db              Tiger/PostgreSQL access, migrations and seed scripts
packages/resolution      Claim scoring and capacity interpretation
packages/shopify         Shopify adapter (live, demo and fake modes)
packages/openai          OpenAI adapter
packages/backboard       Backboard adapter
packages/events          Event persistence/broadcast utilities
packages/test-fixtures   Deterministic shared fixtures
rox_data                 Messy-data ingestion agents, corpus generator and scorer
sql                      Migrations and seed data
scripts                  Bootstrap, provider verification, demo, and load tools
docs                     Architecture, contracts, runbooks, owner tasks and evidence
magicpatterns            Standalone Vite design prototype (not part of the workspace)
```

Read [`AGENTS.md`](AGENTS.md) before implementation. Owner-specific scopes live in [`docs/TASKS`](docs/TASKS).

## Prerequisites

- Node.js 22.9+ (root scripts use `node --env-file-if-exists`) and Corepack
- pnpm 10.14.0
- [uv](https://docs.astral.sh/uv/getting-started/installation/) — the bootstrap creates the Python 3.12 solver environment in `services/solver/.venv`
- Docker (optional, for PostgreSQL mode)

Commands below target macOS/Linux.

## Setup and run

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm bootstrap          # pnpm install --frozen-lockfile, solver venv, workspace build
cp .env.example .env
pnpm dev
```

Open `http://localhost:3000`. `pnpm dev` starts the web app (3000), orchestrator (3001), and solver (8000) and stops them together. Start the optional Electron overlay separately with `pnpm --filter @molecule/desktop dev`; see [`docs/DESKTOP.md`](docs/DESKTOP.md) for permissions, setup, and limitations.

### PostgreSQL mode

```bash
docker compose up -d --wait
pnpm db:migrate
pnpm db:seed
STORAGE_MODE=postgres pnpm dev
```

The seed and reset commands require `DEMO_MODE=true`. `pnpm db:reset` restores the synthetic marketplace while retaining order audit history. See [the runbook](docs/RELEASE.md) for live configuration, verification, recovery, and operational limits.

## Environment variables

Copy [`.env.example`](.env.example) to `.env`; root development and database commands load it, and shell values take precedence. Never commit real secrets.

| Variable                                                                             | Purpose                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                                                     | OpenAI key; required when `USE_MOCK_OPENAI=false`                                           |
| `USE_MOCK_OPENAI`                                                                    | `true` (default) uses the deterministic compiler and voice simulation                       |
| `OPENAI_COMPILER_MODEL`, `OPENAI_REALTIME_MODEL`, `OPENAI_TRANSCRIPTION_MODEL`       | Models for intent compilation, realtime voice, and transcription                            |
| `BACKBOARD_API_KEY`, `BACKBOARD_MODE`                                                | Backboard credentials and mode (`demo` or `live`)                                           |
| `BACKBOARD_SMOKE_DATABASE_URL`                                                       | Isolated local database for `scripts/verify-backboard.ts --execute`                         |
| `DATABASE_URL`                                                                       | PostgreSQL/Tiger connection; required when `STORAGE_MODE=postgres`                          |
| `STORAGE_MODE`                                                                       | `local` (file-backed, default) or `postgres` (durable adapters)                             |
| `SHOPIFY_MODE`                                                                       | `demo` (default), `live`, or `fake` (fake store pipeline; requires `STORAGE_MODE=postgres`) |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_ACCESS_TOKEN` | Shopify app credentials or a static access token                                            |
| `SHOPIFY_API_VERSION`, `SHOPIFY_STOREFRONT_DOMAIN`, `MOLECULE_STOREFRONT_DOMAIN`     | Admin API version (`2026-07`) and storefront domain (legacy alias)                          |
| `SHOPIFY_STORES`, `SHOPIFY_SUPPLIER_STORES`                                          | Dev store subdomains and per-merchant store mapping (JSON)                                  |
| `SHOPIFY_SMOKE_DATABASE_URL`, `SHOPIFY_SMOKE_SOLVER_URL`                             | Isolated database/solver for `scripts/verify-shopify-execution.mjs --execute`               |
| `ORCHESTRATOR_URL`, `PORT`, `HOST`                                                   | Orchestrator URL used by the web proxy and scripts, and its listen port/host                |
| `SOLVER_URL`                                                                         | Solver URL (also sets the host/port `pnpm dev` starts it on)                                |
| `DATA_DIR`                                                                           | Directory for local-mode project data (`.molecule-data`)                                    |
| `ALLOWED_ORIGIN`, `DESKTOP_ORIGIN`, `WEB_APP_URL`                                    | Allowed web/desktop origins and the web app URL                                             |
| `DEMO_MODE`                                                                          | Enables the pinned golden path, demo seed/reset, and demo controls                          |
| `CHAOS_SECRET`                                                                       | Secret (16+ characters) for demo chaos controls such as supplier-offline                    |
| `REAL_EXECUTION_ENABLED`                                                             | Must be `true` before live commerce mutations are allowed (default `false`)                 |
| `WEB_PORT`, `MOLECULE_DB_PORT`, `SOLVER_PYTHON`                                      | Optional: web dev port, Docker database port, and solver Python path override               |

## Scripts

| Command                                                                                              | Description                                                                |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm bootstrap`                                                                                     | Install dependencies, create the solver venv, build the orchestrator graph |
| `pnpm dev`                                                                                           | Run web, orchestrator, and solver together                                 |
| `pnpm build` / `pnpm lint` / `pnpm typecheck` / `pnpm test`                                          | Turborepo tasks across the workspace                                       |
| `pnpm format` / `pnpm format:write`                                                                  | Prettier check / write                                                     |
| `pnpm solver:dev` / `pnpm solver:lint` / `pnpm solver:test`                                          | Solver with reload, ruff + mypy, pytest                                    |
| `pnpm test:adversary`                                                                                | Orchestrator tests plus solver tests                                       |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset`                                                 | Apply migrations, seed the synthetic marketplace, reset demo data          |
| `pnpm verify:secrets`                                                                                | Check that no secrets reach client bundles                                 |
| `pnpm verify:desktop` / `pnpm verify:kit` / `pnpm verify:golden`                                     | Mock-provider desktop, kit, and golden-path acceptance runs                |
| `pnpm verify:durable`                                                                                | Durable orchestration acceptance (needs `ORCHESTRATOR_TEST_DATABASE_URL`)  |
| `pnpm verify:openai` / `pnpm verify:voice`                                                           | Provider checks for OpenAI and voice                                       |
| `pnpm shopify:fake:sync` / `shopify:fake:writeback` / `shopify:fake:capacity` / `shopify:fake:reset` | Drive the fake Shopify store pipeline                                      |

Full quality gate, matching CI ([`.github/workflows/verify.yml`](.github/workflows/verify.yml)):

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm solver:lint && pnpm solver:test
pnpm verify:secrets && pnpm verify:desktop && pnpm verify:kit && pnpm verify:golden
```

CI additionally runs the database adapter tests and `pnpm verify:durable` against a TimescaleDB service. Database adapter and durable runtime acceptance commands are in [the runbook](docs/RELEASE.md). Browser interaction, physical macOS permissions, live voice, and paid provider acceptance are separate from these automated checks.

## Canonical demonstration

Ask for “200 premium black onboarding kits by next Friday under CAD 7000, no leather, hoodie logo embroidery, named engraved bottles, vegan snacks and individual packaging.” Correct it with “No polyester.” Approve the solver plan, then use the supplier-offline control on its embroidery supplier. The replacement graph must retain every component and constraint and report the cost and completion changes.

### Golden path

One brief is pinned rather than modelled so a demonstration is deterministic end to end. With `DEMO_MODE=true` the compiler answers `GOLDEN_PATH_PROMPT` (the example brief in the web composer; see `packages/contracts/src/goldenPath.ts`) and its correction “No polyester.” from a fixed intent with zero clarification questions — every other brief still goes through the configured OpenAI adapter. Discovery, merchant quotes, CP-SAT certification, approval and synthetic Shopify execution run unchanged; the solver stays the only feasibility authority. The expected outcome (nine accepted quotes, a seven-node plan at CAD 6,380 under the CAD 7,000 budget, `thread-forge` embroidery, `laser-lab` engraving, `pack-ship` assembly and fulfillment, nine succeeded execution actions) is pinned in `services/orchestrator/src/demo/goldenPath.ts`.

```bash
pnpm verify:golden                                   # boots solver + orchestrator, runs brief → plan → correction → approve → receipt
MOLECULE_URL=http://127.0.0.1:3001 pnpm verify:golden # same run against a stack started with pnpm dev
```

“Next Friday” resolves to the coming Friday, or the one after when fewer than 72 hours remain, so the pinned plan is always feasible.

## Workspace interaction

The command center follows the persisted workflow: brief, merchant quotes, solver validation, then execution. Status and recovery messages describe confirmed server state. Use Ctrl/⌘+Enter to send a brief; attach context after the project exists, then send a correction to include it in compilation. Brief editing closes during processing and after execution. Start a new project for another request; the original receipts remain available.

On phones, the workspace views move into a labeled bottom navigation bar. Graph nodes also have a keyboard-accessible production sequence. Motion uses shared timing/easing tokens and respects reduced-motion preferences. Marketplace and configuration failures have explicit retry controls.

Orchestrator exceptions use the shared `ApiError` envelope with a trace ID and sanitized messages. Validation errors return 400, stale/conflicting actions return 409, provider limits return 429, provider failures return 502/504, and unexpected failures return 500. Refresh the project before retrying an action with an uncertain outcome; commerce mutations are not automatically replayed.

## Deployment and release

There is no hosted deployment configuration in this repository. Operational runbooks cover live provider configuration and release checks: [`docs/RELEASE.md`](docs/RELEASE.md), [`docs/WEB_RELEASE.md`](docs/WEB_RELEASE.md), [`docs/DESKTOP_RELEASE.md`](docs/DESKTOP_RELEASE.md) (the desktop app packages for macOS with `pnpm --filter @molecule/desktop package:mac`), [`docs/SHOPIFY_RELEASE.md`](docs/SHOPIFY_RELEASE.md), [`docs/BACKBOARD_RELEASE.md`](docs/BACKBOARD_RELEASE.md), and [`docs/TIGER_ROX_RELEASE.md`](docs/TIGER_ROX_RELEASE.md).

## Core rules

- Contracts first: request and response shapes come from `@molecule/contracts`.
- Adapters first: application code never imports provider SDKs directly.
- Deterministic validity: only the solver returns `plan.status = "VALID"`.
- Idempotent effects: external writes require `traceId` and `actionKey`.
- Event everything: persist meaningful state changes before or with UI broadcast.
