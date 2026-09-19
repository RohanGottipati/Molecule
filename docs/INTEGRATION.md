# Integrated release ledger

## Branch inventory and disposition

The integration started from pushed `origin/Backboard` (`cc93122`), because the user's only uncommitted file was generated TypeScript metadata. No secret environment file was committed.

| Branch / PR                                                    | Contributions                                                                                          | Overlap and disposition                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `main` (`a59f7f7`)                                             | Architecture, contracts, owner tasks, implementation playbook, workspace scaffolding                   | Common ancestor and eventual PR target.                                                                                                |
| `Backboard` (`cc93122`, `f9e6d4c`, `7a6088a`)                  | Typed quotes, Merchant Twins, persistent-provider memory, RAG, routing, bounded tool loops and council | Integration starting point. Preserve provider package and tests.                                                                       |
| `openai` (`6987159`)                                           | Intent compilation, orchestrator, solver, web, realtime, execution contracts and tests                 | Ancestor of desktop branch; included through that merge.                                                                               |
| `Mac-OS-implementation` (`a2dda05`), draft PR #1 into `openai` | Secure Electron overlay, uploads, commands, settings, realtime and persisted local state               | Merged with its OpenAI ancestry. Additive contract/test imports retained; duplicate quote schemas reconciled. PR #1 remains untouched. |
| `tiger-rox` (`e274652`)                                        | DB, event package, Reality ingestion/resolution, reservations, SQL and fixtures                        | Merged. Root scripts combined; lockfile regenerated with pnpm.                                                                         |
| `shopify` (`c70c815`)                                          | Synthetic catalog, seeding and verification scripts                                                    | Merged. Full runtime Shopify adapter remains an integration deliverable.                                                               |

Each merge passed workspace lint, typecheck and tests before the next merge. Python Ruff, mypy and all nine existing solver tests passed after the desktop/OpenAI merge. Passing existing tests does not establish complete product behavior: the gaps below require implementation and expanded acceptance.

## Shared boundary decisions

- `@molecule/contracts` remains the domain contract authority. The OpenAI strict compiler drafts, execution/desktop contracts and Backboard memory/council contracts coexist.
- `QuoteRequestSchema` accepts existing Backboard clients; it normalizes legacy `constraints` and current `hardConstraints` into the same set. `intentVersion` defaults to 1 for legacy callers. `CurrentQuoteRequestSchema` requires a deadline for the execution path. No model can bypass solver certification.
- `MarketplaceSnapshotSchema` is the read model for `GET /api/marketplace`: provider truth, Merchant Twin summaries, provenance, operational counts and persisted events. UI components must validate it and display unavailable data honestly.
- Existing order/session, context upload, approve, chaos and SSE contracts remain compatible.
- Demo data is synthetic operational data in a real local database. External demo adapters must be labeled independently of database status.

## Requirement map at integration baseline

| Requirement                             | Baseline implementation                           | Status / action owner                                                                                       |
| --------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Messy request and corrections           | OpenAI adapter, mock parser, strict drafts        | OpenAI/solver: complete kit components and scoped constraints; preserve ambiguity.                          |
| All components and transformations      | Solver chooses one capability per kind            | OpenAI/solver: replace kind-only model with requirement coverage and dependency validation.                 |
| Real operational persistence            | Tiger SQL separate from local orchestrator store  | Integration: durable session/event/execution path and transactional state.                                  |
| Candidate discovery and historical risk | Reality search placeholder                        | Tiger/Rox: database search, resolved facts, risk percentiles and reproducible seed.                         |
| Raw evidence and conflicts              | Ingestion/resolution unit implementations         | Tiger/Rox: transactional resolution, quarantine, persisted provenance and explainability.                   |
| Persistent Merchant Twins               | Rich Backboard adapter with in-memory bookkeeping | Backboard: database repositories, canonical tools, memory and runnable runtime.                             |
| Real commerce actions                   | Seed scripts; orchestrator mock                   | Shopify: typed real/mock adapters, idempotent product/customer/supplier actions, verified webhook handling. |
| Reservations and concurrency            | Separate stores; limited DB tests                 | Tiger/Rox + Backboard + integration: transactional holds, release, expiry, duplicate protection.            |
| Supplier-offline recovery               | Orchestrator mock path                            | Integration: persisted reversible chaos, replacement plan and jobs, cost/deadline evidence.                 |
| Cohesive web operations product         | Minimal single-page workspace                     | Web: responsive navigation, company graph, conversation, merchants, provenance, analytics and error states. |
| Electron and realtime                   | Existing secure desktop overlay                   | Desktop: integration compatibility and acceptance; physical macOS/audio remain separate.                    |
| Bootstrap and environment               | Incomplete per-branch commands/examples           | Integration: clean install/migrate/seed/run/reset, variable validation and verified blueprint.              |
| Final quality and demo evidence         | Existing narrow suites only                       | Integration: expanded API/DB/solver/provider tests, production builds and browser acceptance.               |

This ledger records the inspected baseline. Final evidence and remaining external limitations belong in the release verification report.
