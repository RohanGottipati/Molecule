# OpenAI/orchestrator operations

This is the operator handoff for the Person 2 implementation. Domain payloads are defined in `@molecule/contracts`; the TypeScript and Python boundaries validate them at runtime.

## Local mock stack

1. Create the solver environment once:

   ```bash
   python3 -m venv services/solver/.venv
   services/solver/.venv/bin/pip install -r services/solver/requirements-dev.txt
   ```

2. Copy `.env.example` to `.env`. Keep `USE_MOCK_OPENAI=true` and `REAL_EXECUTION_ENABLED=false` for the credential-free flow.
3. In separate terminals run:

   ```bash
   pnpm solver:dev
   pnpm --filter @molecule/orchestrator dev
   pnpm --filter @molecule/web dev
   ```

4. Open `http://localhost:3000`, submit the seeded hoodie request, inspect the compiled intent and solver graph, then approve. With demo mode enabled, trigger the supplier-offline control to verify automatic re-planning and idempotent replacement execution.

## Provider configuration

- Compiler default: `gpt-5.6-terra`
- Realtime default: `gpt-realtime-2.1`
- Set `USE_MOCK_OPENAI=false` only on the server and provide `OPENAI_API_KEY` there.
- Run `pnpm verify:openai` before a provider-backed demo. The command prints model, latency, and expiry only; it never prints credentials or raw provider payloads.
- The browser obtains an order-bound ephemeral Realtime client secret from the orchestrator. Realtime function calls are handled in the browser by calling order-scoped orchestrator routes; they never call Shopify or other providers directly.

## Verification

```bash
pnpm exec prettier --check apps/web packages/openai services/orchestrator packages/contracts/src scripts
pnpm lint
pnpm typecheck
pnpm test
pnpm solver:lint
pnpm solver:test
pnpm test:adversary
pnpm build
pnpm verify:secrets
```

The credentialed OpenAI smoke and a physical two-barge-in microphone pass are intentionally separate from CI. If credentials or browser audio are unavailable, keep the mock/text path active and record that limitation rather than weakening validation.

## Safety and recovery policy

- Only `services/solver` may certify `ProductionPlan.status = VALID`.
- Unknown hard facts make a candidate ineligible; they are never guessed.
- A merchant timeout is treated as merchant unavailability, not an order-wide error.
- Approval includes both `planId` and `intentVersion`; stale approvals are rejected.
- Automatic supplier recovery requires a previously approved plan and a solver-certified replacement within the current budget and deadline. Increased cost without an explicit budget requires renewed approval. Unapproved projects always require approval; infeasible recovery enters `NEEDS_HUMAN`.
- `POST /api/chaos` is available only in demo mode and requires localhost or the server-side `CHAOS_SECRET`.
