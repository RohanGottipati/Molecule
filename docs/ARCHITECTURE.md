# Architecture

Molecule OS turns a customer request into a validated, observable, and executable production plan. Provider-specific behavior is isolated behind adapters; shared runtime contracts are the integration seam.

## Request flow

1. The web app sends raw text, voice-derived text, and asset references to the orchestrator.
2. The OpenAI compiler produces a schema-valid `ProductIntent`.
3. The Reality service resolves canonical merchant facts and returns candidate capabilities with provenance and risk.
4. Merchant Agents fan out typed `QuoteRequest` values and return validated `QuoteResponse` values.
5. The solver alone validates constraints and returns a `ProductionPlan` marked `VALID` or `UNSAT`.
6. The orchestrator commits valid plans through the Shopify adapter using deterministic action keys.
7. Each meaningful transition is persisted as a `MoleculeEvent`; the UI consumes the persisted stream through SSE.

```text
Web -> Orchestrator -> OpenAI compiler -> ProductIntent
                     -> Reality/Tiger -> candidates + provenance
                     -> Merchant Agents/Backboard -> quotes
                     -> Solver -> VALID | UNSAT
                     -> Shopify -> products, customer order, supplier jobs
                     -> Tiger events -> SSE -> Web
```

## Locked choices

| Concern            | Choice                                           |
| ------------------ | ------------------------------------------------ |
| Monorepo           | pnpm workspaces + Turborepo                      |
| Customer UI        | Next.js, React, React Flow, WebRTC/Web Audio     |
| Orchestrator       | Node.js and TypeScript                           |
| Solver             | Python, FastAPI, OR-Tools CP-SAT, NetworkX       |
| Data               | Tiger Data / PostgreSQL                          |
| Runtime validation | Zod in TypeScript; Pydantic mirror in the solver |
| UI event stream    | SSE backed by persisted database events          |

## Boundaries

- Feature code depends on provider interfaces, never provider SDKs.
- Provider adapters have real and deterministic mock implementations with identical contract behavior.
- External mutations are orchestrator actions carrying `traceId` and `actionKey`.
- Vector search generates candidates; it does not certify compatibility.
- Model output never certifies feasibility, live capacity, or operational truth.
- The database event log is the source of truth for replay and UI reconnection.

## Ownership

| Area                        | Paths                                                                             |
| --------------------------- | --------------------------------------------------------------------------------- |
| Shopify                     | `apps/shopify-app`, `packages/shopify`                                            |
| OpenAI/orchestration/solver | `apps/web`, `packages/openai`, `services/orchestrator`, `services/solver`         |
| Backboard                   | `packages/backboard`, `services/merchant-agents`                                  |
| Tiger/Reality/contracts     | `packages/contracts`, `packages/db`, `packages/events`, `services/reality`, `sql` |

Cross-owner contract changes should land independently before provider implementations consume them.
