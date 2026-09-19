# Shopify Changelog

Append-only, newest first. One entry per change that touches `apps/shopify-app/**`, `packages/shopify/**`, or Shopify-facing scripts/docs. Keep entries short: what changed, why, and what it unblocks. Update `STATUS.md` in the same commit when an entry moves a checklist item.

## 2026-09-19 (3)

- Fixed partial replacement/cancellation recovery: uncertain cancellations reconcile with their original action keys; outgoing plans cannot recommit; inherited jobs survive a failed replacement product operation; already superseded jobs cannot be reused. Finish reconciliation of an incomplete replacement before cancelling it (`PREVIOUS_EXECUTION_PENDING`); finish partial cancellation before executing a new plan (`PLAN_CANCELLATION_INCOMPLETE`). Retry cancellation through `supersede`, not `commit`.
- Rejected client-credentials tokens are evicted on HTTP 401. The next explicit request obtains a new token; the transport never automatically replays a commerce mutation.
- Catalog mocks reject malformed money, fractional draft quantities, and composite writes without a configured central store, matching the execution boundary's fail-closed behavior. Added deterministic regression coverage; no live commerce writes.

## 2026-09-19 (2)

- Reconciled `STATUS.md` and `COMPETITIVE_STRATEGY.md` against `docs/TASKS/SHOPIFY_LOOP.md`, a detailed execution brief (8 dev stores, ~797 seeded products, T1–T16 task checklist, HUMAN-1..8 blockers) that already existed on disk but hadn't been read yet when this folder was first written. `SHOPIFY_LOOP.md` is now treated as the canonical task tracker; `STATUS.md` summarizes it instead of duplicating a separate checklist, and `COMPETITIVE_STRATEGY.md`'s recommendations were re-scored against what T1–T16 already covers (most of the original recommendations turned out to already be planned — see §3 "Assessment against the active plan"). Confirmed with the user that HUMAN-1 (select Shopify prize on Devpost, due 2026-09-19 2:00pm EDT) was already handled.

## 2026-09-19 (1)

- Added `apps/shopify-app/docs/` (this folder): `STATUS.md`, `CHANGELOG.md`, `COMPETITIVE_STRATEGY.md`. Establishes the living record for Shopify-scope work and the researched plan for the Hack the North Shopify track. No code changes.

## 2026-09-19 — `c70c815`

- Added `scripts/seed-shopify.mjs`, `scripts/seed-data.mjs`, `scripts/verify-shopify.mjs`. Gives every dev store a deterministic demo catalog (idempotent by handle, resumable under a time budget, throttle-aware) and a sanitized way to verify store connectivity/scopes before a demo. Unblocks `DEMO_RUNBOOK.md`'s reset gate. Added `SHOPIFY_API_KEY` to `.env.example`.

## 2026-09-19 — `a59f7f7`

- Added a new Shopify env var to `.env.example` (client credentials setup groundwork).

## 2026-09-19 — `2427766`

- Repository initialized with `apps/shopify-app`, `packages/shopify` scaffolds (empty) and `docs/TASKS/SHOPIFY.md` owner task.
