# Tiger Data and Reality Owner Task

## Scope

Own `packages/contracts/**`, `packages/db/**`, `packages/events/**`, `packages/test-fixtures/**`, `services/reality/**`, `sql/**`, provenance/operations UI, and their tests.

## First deliverable

Extend canonical contracts as required, create core migrations, seed merchants/capabilities, and implement claim ingestion/resolution with explicit conflicted and unknown states. Candidate search may rank results but cannot certify compatibility.

## Definition of done

- Conflicting 100/day, 50/day, and fresh 20/day capacity sources resolve with visible provenance.
- Malformed sources are quarantined rather than guessed.
- Reservations are transactional, concurrency-safe, and idempotent.
- Event and fulfillment time-series queries have reproducible tests.
