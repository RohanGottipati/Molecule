# Molecule OS

> Say what should exist. Molecule assembles a company to make it.

Molecule OS is a contract-first marketplace orchestrator. It compiles a customer request into a typed intent, resolves merchant capabilities from evidence, requests quotes from persistent merchant agents, validates a production graph with a deterministic solver, and commits the resulting commerce actions through idempotent provider adapters.

This repository is initialized from the **Molecule OS AI-Agent-Optimized Implementation Playbook** in [`docs/Molecule_OS_AI_Agent_Implementation_Playbook.docx`](docs/Molecule_OS_AI_Agent_Implementation_Playbook.docx).

## Status

The repository currently contains the implementation boundaries, shared contracts, task ownership, and workspace tooling. Provider integrations and applications are intentionally left as scoped implementation tasks.

## Bootstrap

Prerequisites: Node.js 22+, Corepack, pnpm 10+, Python 3.12+, and PostgreSQL/Tiger Data for database-backed work.

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm test
pnpm typecheck
```

Do not add real secrets to committed files.

## Repository map

```text
apps/web                 Customer UI and production graph
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

## Core rules

- Contracts first: request and response shapes come from `@molecule/contracts`.
- Adapters first: application code never imports provider SDKs directly.
- Deterministic validity: only the solver returns `plan.status = "VALID"`.
- Idempotent effects: external writes require `traceId` and `actionKey`.
- Event everything: persist meaningful state changes before or with UI broadcast.
