# Demo Runbook

## Reset gate

Before a demo, reset the deterministic seed world and verify OpenAI, Backboard, Tiger Data, and all configured Shopify stores. Never expose provider credentials in logs or UI.

## Five-minute flow

1. Capture a request and one hard-constraint correction; show the typed intent changing.
2. Show a conflicting merchant claim resolving with provenance.
3. Show merchant agents quote and the p95 risk signal affect selection.
4. Show the solver certify a plan and Shopify create the composite product and supplier jobs.
5. Trigger the reversible `supplier_offline` scenario.
6. Show invalidation, replacement quotes, a new valid plan, and an updated supplier job.
7. Summarize the cost/deadline delta and show persisted events.

The full detailed runbook and acceptance matrix are in the source playbook document.
