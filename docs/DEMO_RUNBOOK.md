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

## B5 persistent memory demo prep

Before the demo, seed the "Never auto-accept rush embroidery above 40 units while
machine #2 is down" correction through `MerchantTwinService.ensureMerchantMemory`
(`buildDemoMerchantMemory()` in `@molecule/backboard`) — the supported API workflow —
rather than relying on the assistant to extract it live from a conversation. Memory
is only ever written through this explicit call; a quote request only reads it back
(`GET /api/merchant-agents/:merchantId/memory` for the sanitized merchant-memory
card), so there is no uncontrolled extraction timing to depend on. If a live run's
memory recall still looks inconsistent, re-seed via the same call immediately before
going on and treat the memory step as **readonly** for that demo — do not attempt to
record new memory from the live assistant on stage.
