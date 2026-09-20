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
- [x] Select the narrow apparel scenario and its uncertainty/action boundary; see [Order 2](../DATABASE_ORDER2.md).
- [ ] Add run-specific resolution snapshots before certifying resolution/outlier accuracy.
- [ ] Establish a human-labelled real-document holdout for one operational scenario; the private validator exists, but authorized inputs and reviews are still required ([Order 3](../DATABASE_ORDER3.md)).
- [x] Strict capacity normalization and supplier attribution implemented and tested on the synthetic corpus; **not yet validated on real documents**, so not benchmark-driven ([Order 4](../DATABASE_ORDER4.md)).
- [ ] Integrate shared contracts/resolver and complete approved, idempotent actions. Decision rule and approval-gated proposals done; the trigger into `Orchestrator.recoverResource` needs an orchestrator endpoint ([Order 5](../DATABASE_ORDER5.md)).
- [x] Benchmark Tiger's contribution live and read-only ([Order 6](../DATABASE_ORDER6.md)). Replay/recovery timing and load not measured. Exposing provenance to the user remains open.

Stored scores are preliminary diagnostics, not production accuracy. Finish one
acceptance gate before increasing dataset volume or expanding feature scope.
