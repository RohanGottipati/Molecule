# Tiger Data and Reality Owner Task

## Scope

Own `packages/contracts/**`, `packages/db/**`, `packages/events/**`, `packages/test-fixtures/**`, `services/reality/**`, `sql/**`, provenance/operations UI, and their tests.

## Original foundation deliverable

Extend canonical contracts as required, create core migrations, seed merchants/capabilities, and implement claim ingestion/resolution with explicit conflicted and unknown states. Candidate search may rank results but cannot certify compatibility.

## Definition of done

- Conflicting 100/day, 50/day, and fresh 20/day capacity sources resolve with visible provenance.
- Malformed sources are quarantined rather than guessed.
- Reservations are transactional, concurrency-safe, and idempotent.
- Event and fulfillment time-series queries have reproducible tests.

## Current priorities (2026-09-19)

The foundation exists. Follow [DATABASE_ROX.md](../DATABASE_ROX.md) in order:

- [x] Audit source/synthetic provenance, duplicate signatures and database health; see [Order 1](../DATABASE_ORDER1.md). Unlabelled provenance and candidate duplicates remain review items.
- [x] Repair scoring population, matching and units; persist frozen, versioned local evidence. Unsupported historical resolution scoring is disabled.
- [ ] Add run-specific resolution snapshots before certifying resolution/outlier accuracy.
- [ ] Establish a human-labelled real-document holdout for one operational scenario.
- [ ] Improve supplier attribution and normalization against that benchmark.
- [ ] Integrate shared contracts/resolver and complete approved, idempotent actions.
- [ ] Benchmark Tiger's workflow contribution and expose provenance to the user.

Stored scores are preliminary diagnostics, not production accuracy. Finish one
acceptance gate before increasing dataset volume or expanding feature scope.
