# Molecule OS

> Say what should exist. Molecule assembles a company to make it.

Molecule OS is a contract-first marketplace orchestrator. It compiles a customer request into a typed intent, resolves merchant capabilities from evidence, requests quotes from persistent merchant agents, validates a production graph with a deterministic solver, and commits the resulting commerce actions through idempotent provider adapters.

This repository is initialized from the **Molecule OS AI-Agent-Optimized Implementation Playbook** in [`docs/Molecule_OS_AI_Agent_Implementation_Playbook.docx`](docs/Molecule_OS_AI_Agent_Implementation_Playbook.docx).

## Status

The web command center and Electron overlay run the complete request → quote → solver → approval → execution → recovery workflow. Local mode persists projects on disk. PostgreSQL mode connects Reality evidence, Merchant Twins, capacity reservations, commerce action journals, contexts, and replayable events. Provider modes are displayed explicitly; the default demonstration creates synthetic commerce records without charging anyone.

## Bootstrap

Prerequisites: Node.js 22.9+, Corepack, pnpm 10.14.0, and [uv](https://docs.astral.sh/uv/getting-started/installation/). The bootstrap installs the Python 3.12 solver environment. Docker is optional for the PostgreSQL mode. Commands below target macOS/Linux.

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm bootstrap
cp .env.example .env
pnpm dev
```

Open `http://localhost:3000`. The launcher starts the web app, orchestrator, and solver and stops them together. Start the optional Electron overlay separately with `pnpm --filter @molecule/desktop dev`.

For PostgreSQL mode:

```bash
docker compose up -d --wait
pnpm db:migrate
pnpm db:seed
STORAGE_MODE=postgres pnpm dev
```

The seed and reset commands require `DEMO_MODE=true`. `pnpm db:reset` restores the synthetic marketplace while retaining order audit history. Do not add real secrets to committed files. See [the runbook](docs/RELEASE.md) for live configuration, verification, recovery, and operational limits.

## Canonical demonstration

Ask for “200 premium black onboarding kits by next Friday under CAD 7000, no leather, hoodie logo embroidery, named engraved bottles, vegan snacks and individual packaging.” Correct it with “No polyester.” Approve the solver plan, then use the supplier-offline control on its embroidery supplier. The replacement graph must retain every component and constraint and report the cost and completion changes.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm solver:lint && pnpm solver:test
pnpm verify:secrets && pnpm verify:desktop && pnpm verify:kit
```

Database adapter and durable runtime acceptance commands are in [the runbook](docs/RELEASE.md). Browser interaction, physical macOS permissions, live voice, and paid provider acceptance are separate from these automated checks.

## Repository map

```text
apps/web                 Customer UI and production graph
apps/desktop             macOS Electron voice/context overlay
apps/shopify-app         Shopify embedded/central app
services/orchestrator    Workflow, actions, state machine, and SSE
services/solver          Deterministic Python solver
services/merchant-agents Backboard Merchant Twins
services/reality         Canonical claims and candidate search
packages/contracts       Shared runtime-validated contracts
packages/db              Tiger/PostgreSQL access
packages/shopify         Shopify adapter
packages/openai          OpenAI adapter
packages/backboard       Backboard adapter
packages/events          Event persistence/broadcast utilities
packages/test-fixtures   Deterministic shared fixtures
sql                      Migrations and seed data
scripts                  Bootstrap, provider verification, demo, and load tools
```

Read [`AGENTS.md`](AGENTS.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and [`docs/CONTRACTS.md`](docs/CONTRACTS.md) before implementation. Owner-specific scopes live in [`docs/TASKS`](docs/TASKS).

For the desktop application, permissions, setup, API boundaries, demo instructions, and verification limitations, see [`docs/DESKTOP.md`](docs/DESKTOP.md).

## Core rules

- Contracts first: request and response shapes come from `@molecule/contracts`.
- Adapters first: application code never imports provider SDKs directly.
- Deterministic validity: only the solver returns `plan.status = "VALID"`.
- Idempotent effects: external writes require `traceId` and `actionKey`.
- Event everything: persist meaningful state changes before or with UI broadcast.
