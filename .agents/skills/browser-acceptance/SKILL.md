---
name: molecule-postgres-ui-acceptance
description: Safely exercise Molecule's browser kit flow with populated provenance and durable demo execution.
---

# PostgreSQL browser acceptance

## Devin Secrets Needed
None for synthetic demo providers. Use only authorized local PostgreSQL credentials; never enable paid commerce for this workflow.

## Setup
- Read AGENTS.md, docs/RELEASE.md and the current environment blueprint.
- Use a new isolated disposable PostgreSQL database, not another acceptance run's database. If psql is absent, the installed `pg` package in packages/db can create it.
- Run `pnpm db:migrate` and `pnpm db:seed` with DATABASE_URL pointing to that database.
- Set DEMO_MODE=true, STORAGE_MODE=postgres, USE_MOCK_OPENAI=true, BACKBOARD_MODE=demo, SHOPIFY_MODE=demo, REAL_EXECUTION_ENABLED=false, and an isolated persistent home-directory DATA_DIR.
- Start web, orchestrator and the real CP-SAT solver per the current release runbook. Coordinate SOLVER_URL with the actual solver port; use an available alternate port if necessary.
- If a root production build has run while Next dev remains active, restart the dev stack before diagnosing unexpected root 404s.
- Use independent web/orchestrator/solver processes for outage testing; combined launchers may stop sibling services. A stopped launcher shell can leave child listeners: inspect ps and ss before restarting, terminate only identified processes, and confirm the intended port is closed. Stop both the orchestrator tsx watch parent and its src/index.ts child so the watcher cannot restart the test outage.
- Local-storage catalogs may not contain claims or merchant memory. Use the seeded PostgreSQL mode when testing populated evidence.

## Browser flow and evidence
- Submit the exact user-specified canonical text, without paraphrasing compiler failures away.
- Check seven production nodes and six dependencies; record concrete cost, deadline and hard constraints.
- Correct with `No polyester.` and check intent-version replacement in a second tab before approval.
- Approve using the UI; inspect seven synthetic jobs and disabled repeated approval.
- Take the selected embroidery supplier offline using the UI. Check replacement, cost delta, preserved requirements and reservation/recovery counts in Operations.
- Reload before checking persistence. Do not equate reload with a tested process restart or event replay.
- An existing SSE connection may survive browser offline emulation; do not infer a reconnect from HTTP retry success.
- For terminal SSE failure testing, stop the actual orchestrator long enough for repeated proxy502s and the10-second retry cap; keep web/solver running. Restart with identical database and flags. Do not refresh, reload or navigate until automatic connection recovery and stale sync-warning clearing have been observed.
- Capture Network.requestWillBeSent, responseReceived, eventSourceMessageReceived and request-end events via read-only CDP. Close duplicate app tabs first. Confirm retry after cursor equals the last valid numeric SSE ID and at most one active stream exists. HTTP200 polling alone does not prove EventSource recovery.
- Distinguish persisted initial replay and cursor resume from delivery of new events missed during downtime. A ready-only resumed stream cannot establish missing-event delivery or injected duplicate-frame suppression. Test cleanup by leaving for New project during backoff and observing no old-project request for longer than the maximum retry delay, including after service restoration.
- Run budget-only infeasibility cases before mutating the supplier catalog or in a separate isolated dataset. Previous chaos and reservations can independently cause UNSAT.
- At narrow widths use the accessible production sequence to inspect graph nodes; evidence/receipt tables scroll independently.
- Use CDP only for read-only diagnostics, screenshot capture, and device/media/network emulation. Ensure emulation remains attached during the visible scenario and restore desktop/online afterward.
- COMPLETED means synthetic commerce records and accepted jobs, never physical delivery.
