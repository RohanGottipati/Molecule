# Order 5: resolved capacity to an approved replan

Status: **decision and proposal stages implemented and tested; the final trigger
is not wired.** No Shopify write was made.

Target flow: a resolved capacity change affects candidate selection, triggers a
solver-certified replan, and updates Shopify after approval.

## What exists

| Step                                                | Where                                                               | State                                       |
| --------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| Resolve conflicting claims into one capacity fact   | ROX `resolve` stage                                                 | Existing                                    |
| **Decide what a resolved fact means for the job**   | [`availability.mjs`](../rox_data/pipeline/availability.mjs)         | **New, 13 tests**                           |
| **Queue an approval-gated proposal**                | `act` stage, section 3 in [`act.mjs`](../rox_data/pipeline/act.mjs) | **New; not run end to end**                 |
| Replan around a changed resource (solver-certified) | `Orchestrator.recoverResource` / `recoverSupplier`                  | Existing (TypeScript)                       |
| Shopify inventory webhook to `recoverResource`      | `durableRuntime.ts` `attachResourceRecovery`                        | Existing, **mapped catalog resources only** |
| Approval and idempotent Shopify update              | `Orchestrator.approve`, `ActionLedger`                              | Existing                                    |
| **Proposal to `recoverResource`**                   | none                                                                | **Missing**                                 |

## The decision rule

For a job of `units` in `windowHours` (defaults 200 in 72 h, from
`ROX_JOB_UNITS` and `ROX_JOB_WINDOW_HOURS`):

| Resolved fact                                                                                 | Decision | Action                                       |
| --------------------------------------------------------------------------------------------- | -------- | -------------------------------------------- |
| Rate covers the job                                                                           | eligible | none                                         |
| Rate is short, or zero                                                                        | excluded | `request_replan`                             |
| Unknown or conflicted                                                                         | blocked  | ask the supplier (already drafted by step 1) |
| Stale (default 14 days), no source date, not a `units/day` rate, or expires inside the window | blocked  | `ask_supplier_to_confirm`                    |

The rule is that only a fact we are sure of can remove a supplier. Excluding one
on a conflicted number would turn a data-quality problem into a wrong business
decision. Capacity is assumed to be per calendar day, since sources say "per day"
without saying working days; the assumption is recorded on every result.

Each decision carries a deterministic `actionKey` built from supplier,
capability, job, winning claim and outcome. Re-running the pipeline produces the
same key and updates the same queue row, so a proposal cannot be queued twice.
Nothing executes: the queue row has `requiresApproval: true`.

## Current live data

A read-only pass over the 9 capacity resolutions in Tiger found **all 9
conflicted**, so today none would be excluded; all fall to the supplier
questions. The `request_replan` path is therefore exercised by unit tests only,
not by real resolved data.

## What is missing, and why it was not written

`Orchestrator.recoverResource(orderId, resourceId)` already does the hard part.
What does not exist is an entry point that says "this supplier's resolved
capacity changed": `/api/chaos` accepts only `supplier_offline`, which marks the
merchant offline, the wrong meaning. The Shopify webhook path reacts to
inventory of mapped catalog resources, not to ROX-resolved capacity.

Adding it means editing `services/orchestrator`, which belongs to another owner
(see `AGENTS.md`), so it was left for coordination. The contract needed:

```
POST /api/availability/changed        (same authorization as /api/chaos)
{ orderId, merchantId, capabilityId, actionKey }
```

The handler should: require the `actionKey` to belong to an approved
`rox_review_queue` row; be idempotent on it; call `recoverSupplier(orderId,
merchantId, resourceId)`; and leave approval of the resulting plan to the
existing approval path. Nothing new is needed on the Shopify side, since the
existing ledger already updates Shopify only after approval.

## Not done

- The endpoint and bridge above.
- A run of the `act` stage's new section against the database (only the decision
  logic was executed against live rows, read-only).
- A demo scenario with a resolved, insufficient capacity. Live data has none.
- `pnpm verify:kit` and the durable orchestrator tests were not run.
