# Competitive Strategy — Hack the North Shopify Track

Research + recommendations for making Molecule OS's Shopify integration win the Shopify challenge. Update this file whenever the strategy changes (new research, a judging update, a scope cut). Keep the newest reasoning at the top of each section rather than deleting superseded reasoning — cross it out instead so we don't re-litigate settled decisions.

## 1. What the track actually rewards (researched 2026-09-19)

From the official Hack the North 2026 Devpost challenge page:

- **Judging criteria, verbatim:**
  - *Technical Excellence* — "Sophisticated, appropriate use of AI with quality execution."
  - *Impact Potential* — "Meaningfully improves merchant operations or customer experience."
  - *Innovation Factor* — "Unexpected approaches that make us think differently about commerce."
- **Theme:** AI-powered merchant superpowers, commerce intelligence & data insights, workflow automation, LLM applications in the commerce ecosystem, customer experience.
- **Suggested (not required) stack:** Shopify Admin API, Remix, Polaris.
- **Prize:** Shop Cash per winning team member.
- Broader Hack the North judging (all tracks) additionally weighs technical complexity, creativity, how the system handles real-world messiness, and practical utility — technical difficulty is typically the single most-weighted general criterion.

Sources: [Hack the North 2026 Devpost](https://hackthenorth2026.devpost.com/), [Hack the North](https://hackthenorth.com/), past finalist projects at museum.hackthenorth.com.

**Read on this:** the track is explicitly not "best Shopify app" in the generic app-store sense. It's judged as an AI/commerce system, with Shopify as the substrate that makes the AI's output real (actual products, actual orders, actual operations) rather than a chat demo. That framing favors Molecule OS's architecture over a typical single-purpose Shopify app, *if* the Shopify layer is deep enough to visibly carry real state — not just a `productSet` call at the end.

## 2. Why Molecule OS already fits the brief

Molecule's pitch — compile a free-text request into a typed intent, resolve real merchant capability, get live AI-agent quotes, deterministically validate a production plan, commit it as real commerce operations — maps directly onto all three criteria:

| Judging criterion | Molecule component that earns it |
| --- | --- |
| Technical Excellence | OpenAI structured-output compiler + Backboard merchant-agent tool-calling loop, both behind typed, validated, timeout-guarded adapters (not a bare prompt-and-hope chat wrapper) |
| Impact Potential | Solver-certified plans mean the "AI-powered" claim is backed by a deterministic guarantee — merchants get real operations, not a hallucinated promise. The self-heal scenario (judge edits live inventory in Admin, a replacement supplier job appears) demonstrates operational resilience, not just a happy path |
| Innovation Factor | Multi-merchant marketplace assembled on demand from a single customer sentence, with provenance-tracked facts and solver-certified feasibility — this is not another "AI writes product descriptions" app |

**The risk this doc originally flagged (2026-09-19, before `docs/TASKS/SHOPIFY_LOOP.md` existed):** those strengths live in `services/orchestrator`, `services/solver`, `services/merchant-agents` — if the Shopify layer were just "call `productSet` once at the end," the system's sophistication would be invisible on the Shopify side specifically, and the demo would read as "AI backend + one API call." `SHOPIFY_LOOP.md`'s task plan (T1–T16, see `STATUS.md`) already targets exactly this risk — composite product + metafield provenance + per-supplier draft-order jobs + a self-heal loop driven by real Admin edits. The recommendations below are now framed against that plan: confirming what it already covers, and surfacing what it doesn't yet.

## 3. Assessment against the active plan (`SHOPIFY_LOOP.md` T1–T16)

### 3.1 Represent the plan graph, not just a SKU — **covered, already the plan's design**

This doc originally argued for attaching the full plan (node graph, risk score, provenance) to the composite product as a metafield, and giving each supplier obligation a distinct, checkable Shopify object rather than a free-text note. `SHOPIFY_LOOP.md` T5 does exactly the metafield part (`planId`, `orderId`, `riskScore`, `p95`, `provenance`, with metafield **definitions** created first so they render in Admin) and T6 does the supplier-obligation part.

~~Original suggestion: use the Fulfillment Orders API (a distinct fulfillment order per supplier/location) for supplier obligations.~~ Superseded: the granted scopes (`STATUS.md`) don't include what Fulfillment Orders needs for this pattern, and T6 instead uses one `draftOrderCreate` per plan node per supplier store, tagged (`MOLECULE_JOB`, `plan:<id>`, `node:<id>`) with `supersedeJob` tagging-not-deleting on reroute. This is the right call for a demo: draft orders are simpler, don't require fulfillment-service registration, and the tag-based supersede trail is *more* visible to a judge reading Admin than a fulfillment-order status transition would be. No action needed here — just don't reintroduce Fulfillment Orders later without re-checking scopes.

The "show it changing live in Admin" instinct is exactly T9's 90-second Shopify demo cut and the hero self-heal moment in `SHOPIFY_LOOP.md` §"Goal" — already the plan's centerpiece, not a suggestion to add.

### 3.2 Admin-visible UI — **covered as stretch (T16), correctly sequenced last**

T16 ("Embedded Polaris page in Admin: plan plus event feed") is the same idea this doc originally proposed. It's correctly placed in P3 (only after P0/P1 land) rather than earlier — for this track, a merchant-agent + solver + real Admin-state self-heal loop *narrated well from outside Admin* already satisfies "meaningfully improves merchant operations"; an in-Admin page is a nice-to-have polish layer, not the thing that makes or breaks Impact Potential. Agrees with the plan's sequencing; no change recommended.

### 3.3 Webhooks closing the loop back into events — **covered (T8), and it's the load-bearing task**

T8 (poll first, then an HMAC-verified `inventory_levels/update` webhook, deduped, async, feeding the same event type as polling) is the mechanical core of the self-heal hero moment and the single highest-leverage remaining task for Innovation Factor: it's what makes a judge's own Admin edit provably reach the solver. Flag: T8 depends on HUMAN-6 (stable public URL) for the webhook half — the polling fallback in the same task means the demo doesn't hard-block on that human item, which is a good design choice already made. Confirm before the demo that polling alone (worst case, no webhook) still lands within the 90-second cut's timing.

### 3.4 Idempotency as a stated technical story — **covered mechanically, not yet narrated**

`actionKey`-based idempotency is built into T2/T6's acceptance criteria (retry with the same `actionKey` creates nothing new) and `SHOPIFY_LOOP.md` §2 rules. What's still open: nothing in T1–T16 explicitly schedules a "retry on stage, show zero duplicates" demo beat. This is genuinely free — it requires no new code, just a line in `scripts/demo-scenario.md` (T9) or the pitch narration. **Recommend:** whoever writes T9's demo-scenario doc add this as an explicit beat, since it directly answers a judge's likely "how do you handle a flaky API call mid-checkout?" question with a live demonstration instead of a claim.

### 3.5 Shopify Functions for composite-product pricing — **correctly not planned**

Not in T1–T16, and shouldn't be added. High effort (checkout customization, function deployment) relative to judging payoff versus the tasks already scheduled, and off the core pitch. Agrees with the plan's implicit scope cut.

### 3.6 Also confirmed correctly out of scope

- **Hydrogen storefront:** doubly ruled out — `apps/web` is already the customer surface, and the granted scopes don't include `write_publications`, so products aren't even on the Online Store channel. `SHOPIFY_LOOP.md` correctly demos through Admin/`invoiceUrl`, not a storefront.
- **B2B/company accounts, markets, translations:** no connection to the track's themes; not in T1–T16.

### 3.7 New idea not yet in T1–T16: narrate T15 as the Innovation Factor answer

T15 (SimGym-inspired ~20-persona LLM demand check over generated product copy/price, labeled "simulated") is a genuinely strong "unexpected approach to commerce" hook — it's the one piece of the plan that's about *commerce intelligence* rather than *fulfillment orchestration*, which broadens the pitch beyond "AI does supply-chain logistics" into "AI also predicts whether a human would buy this." Since it's P3/stretch, the concrete recommendation is: if time is short, protect T15 over T14/T16 (the plan's own cut order in §5 already says this — "cut in this order: T16, T15, T14, T12" — so T15 is *already* prioritized correctly above T14/T16 in the cut order). No plan change needed, just flagging why that specific ordering is right for the judging rubric specifically (Innovation Factor is the criterion the rest of the plan services least directly).

## 4. Demo narrative implication

`docs/DEMO_RUNBOOK.md` (the cross-team runbook) still describes the Shopify beats in general terms ("Shopify create the composite product and supplier jobs"). `SHOPIFY_LOOP.md` T9 is building a Shopify-specific `scripts/demo-scenario.md` with an exact 90-second cut. Once T9 lands, propose reconciling the two — either linking `demo-scenario.md` from `DEMO_RUNBOOK.md`'s step 4/6, or lifting its beats inline — to whoever owns `DEMO_RUNBOOK.md`, since it's shared across all four owner tracks and shouldn't be edited unilaterally from the Shopify side.

## 5. Resolved questions (were open in the 2026-09-19 draft of this doc)

- **Checkout path:** resolved by T6 — `createCustomerCheckout` returns an `invoiceUrl` via `draftOrderCreate`, not a live storefront checkout (consistent with no `write_publications` scope and the dev-store password page).
- **Scopes for the supplier-obligation model:** resolved — granted scopes support draft orders + inventory, not the wider Fulfillment Orders pattern; T6's draft-order design fits what's actually available.
