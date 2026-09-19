# Contracts

`@molecule/contracts` is the canonical cross-service surface. Import its Zod schemas and inferred TypeScript types; do not recreate domain shapes in an application or service.

## Core domain values

- `ProductIntent`: versioned desired outputs, transformations, constraints, preferences, assets, and ambiguity flags.
- `MerchantCapability`: a merchant's typed supply, transform, assembly, or fulfillment capability.
- `CanonicalClaim`: a normalized claim with source, confidence, authority, and explicit resolution state.
- `QuoteResponse`: a validated accept, counteroffer, or decline response.
- `ProductionPlan`: a solver-produced graph with constraint results, cost, timing, and risk.
- `MoleculeEvent`: the persisted state-change envelope shared by services and the UI.

## Service endpoints

| Route                                   | Contract                                | Rule                                             |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| `POST /api/intents/compile`             | `CompileIntentRequest -> ProductIntent` | Strict schema output only                        |
| `POST /api/reality/ingest`              | source artifact -> `CanonicalClaim[]`   | Preserve source and confidence                   |
| `POST /api/reality/resolve`             | merchant fields -> resolved fields      | Conflicted/unknown are valid outcomes            |
| `POST /api/candidates/search`           | intent/capability need -> candidates    | Search is candidate generation only              |
| `POST /api/merchant-agents/:id/quote`   | `QuoteRequest -> QuoteResponse`         | Live state comes from typed tools/canonical data |
| `POST /api/merchant-agents/:id/reserve` | reservation request -> result           | Transactional and idempotent                     |
| `POST /api/plans/solve`                 | `SolverInput -> ProductionPlan`         | Only route allowed to declare `VALID`            |
| `POST /api/execution/commit`            | valid plan -> receipt                   | Reject plans without solver validation           |
| `POST /api/chaos`                       | scenario -> event and receipt           | Demo-only, authenticated, reversible             |
| `GET /api/orders/:id/events`            | SSE `MoleculeEvent` stream              | Backed by persisted rows                         |

## Compatibility policy

- Additive optional fields may land without a version bump.
- Removing, renaming, or narrowing a field requires a coordinated versioned migration.
- Every boundary parses unknown input at runtime.
- Provider differences are translated in adapters and documented here; providers do not redefine the domain.
- JSON fixtures crossing into Python are parsed against a Pydantic mirror before solver execution.

The executable definitions live in [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts).
