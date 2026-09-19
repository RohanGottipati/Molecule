# OpenAI, Orchestrator, and Solver Owner Task

## Scope

Own `apps/web/**`, `packages/openai/**`, `services/orchestrator/**`, `services/solver/**`, and their tests. Access Shopify, Backboard, and Tiger only through typed interfaces.

## First deliverable

Build the mock text end-to-end path and an OpenAI Responses structured-output intent compiler. Add explicit order-session transitions and strict runtime parsing. Add at least 10 initial-request and 5 correction fixtures. Implement voice only after the mock text path passes.

## Definition of done

- Invalid model output cannot escape the adapter.
- Only the solver can produce a `VALID` plan.
- State changes emit typed events.
- Provider calls have timeouts, typed errors, and mock fallback behavior.
