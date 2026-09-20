# Runtime and real-provider verification — 2026-09-19

**Disposition: not ready for an unqualified real-operation sign-off.** This audit
executed the application, provider reads, browser interactions, database-backed
tests and the Python solver. Passing synthetic tests does not establish live
supplier availability, physical fulfillment or live commerce correctness.

Base revision: `9839b7955dd0edac6fe9faca740dfe4da3607c49`, with the coordinated
uncommitted fixes described below. The session date is September 19 in Toronto;
some artifacts have September 20 UTC timestamps.

The two pre-existing workspace changes (`apps/web/next-env.d.ts` and untracked
`scripts/verify-backboard.ts`) were preserved. The existing development processes
and `.env` were not reconfigured. Remote database access was read-only. Commerce
execution, supplier outages and database resets were limited to newly created
local test databases or temporary synthetic runtimes.

## What actually ran

| Surface             | Executed evidence                                                                                                    | Boundary of the result                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running application | HTTP health, desktop configuration and marketplace reads                                                             | All provider modes reported demo except the real CP-SAT solver. This differs from `.env`, which enables live OpenAI.                                                                                    |
| OpenAI Responses    | Real adapter compiled a synthetic two-hoodie request to `READY`; canonical kit and correction also submitted         | The kit requested missing artwork/names and was not solver-certified. Model output varied between calls.                                                                                                |
| OpenAI Realtime     | Real ephemeral session grant, WebRTC connection, synthetic audio transcription, tool dispatch and playback exercised | An unexpected demo execution and intermittent playback-state failure were observed; no physical microphone or real commerce was used. See approval fix below.                                           |
| Backboard           | Authenticated real model catalog read and four routing lanes                                                         | Only the first 200 of 16,325 reported models are returned. All lanes selected the same first eligible model. Inference, documents, tools and persistent memory were not verified live.                  |
| Shopify             | Real authenticated catalog reads through the adapter across eight configured stores                                  | 20,815 products, 22,238 variants and six tracked capacity items read. These are provider records, not independent proof of stock/manufacturing truth. No external orders, updates or checkout executed. |
| Tiger/PostgreSQL    | Real remote connection, aggregate inventory, migration checksums, schema parsing and Reality reads                   | All 21 migration checksums matched. 227 capabilities, six sessions, 523 claims and 919 events parsed; this does not make their business facts reliable.                                                 |
| Solver              | Python unit suite, real HTTP orchestration, material exclusion counterexamples and 100 catalog recipes               | Actual CP-SAT runs; synthetic inputs except for reproduced model-output constraints.                                                                                                                    |
| Web                 | Production build in an isolated copy, real Chromium, real local PostgreSQL and real solver                           | Providers synthetic. Exact canonical brief, correction, attachment, approval and outage used through UI.                                                                                                |
| Desktop             | Integration scripts, ten mock voice sessions and bounded live synthetic voice                                        | Native permissions were simulated and playback muted. Physical devices, permissions, packaging, signing and notarization were not certified.                                                            |

## Defects addressed

1. **Missing Shopify SKUs rejected valid catalogs.** One real store had 23 variants
   without SKUs. The read snapshot schema now preserves missing SKUs as empty
   strings and retains each native variant ID. Product creation still requires a
   SKU. Regression tests include null/empty SKUs and tracked capacity; the live
   store retest preserved all 166 distinct variants.
2. **Material exclusion could admit blends.** One live compiler response encoded
   “No polyester” as `material neq polyester`. CP-SAT correctly treats that as
   exact inequality and accepted a cotton/polyester blend. The compiler prompt
   now specifies `not_contains`, and the mapper blocks ambiguous material
   inequalities in new or retained hard constraints. It requests repair or
   clarification instead of silently rewriting customer intent. The solver's
   generic inequality semantics were preserved.
3. **Voice tools could authorize commerce.** The model-facing desktop tool list
   included `approve_action`, and dispatch required a transcript but no separate
   confirmation. A deterministic regression demonstrates that a status-request
   transcript plus that tool call reached execution. Desktop voice now excludes
   the tool and rejects unsolicited approval calls. The existing explicit app
   approval button remains available. Voice approval now requires that click.
4. **Research normalization guessed unstated facts.** ROX assigned daily capacity,
   hours and CAD when period, time unit or currency was absent. It now quarantines
   unsupported/missing/ambiguous units rather than inventing them. Existing remote
   claims were not rewritten or reprocessed.
5. **Creation accepted invalid idempotency keys.** `POST /api/orders` accepted
   empty and oversized action IDs; an empty ID aliased distinct requests to one
   project. It now parses the shared `ActionIdSchema` before persisting anything.
   Valid replay and independent requests without supplied IDs retain their behavior.
6. **Mock inventory identity broke webhook supersession.** Capacity snapshots
   identified ProductVariants where real Shopify inventory-item IDs are required.
   Numeric webhook IDs then formed a different source stream. Mock snapshots and
   inventory adjustments now use stable InventoryItem identities without changing
   variant IDs. Database tests verify single-stream replacement resolves to zero
   and independent StitchWorks outage evidence remains conflicted; both require
   the old snapshot claim to be superseded.

## Observed blockers and limitations

### The remote operational data cannot fulfill the canonical request

The real Reality service returned HTTP 200 with **zero candidates** for 200 kits.
Of 227 capabilities, 226 were blocked: 218 by unknown merchant status and eight
by conflicting operational fields. The only unblocked capability was a bottle
with available quantity 142.86. Reducing the request to one unit returned only
that bottle; it did not establish a complete kit network.

474 of 523 canonical claims had generated `corpus:` sources, including 21 of 29
current resolved winners. There were 178 conflicted claims. Synthetic benchmark
facts therefore participate in the operational resolver. Six persisted sessions
contained no execution receipts: three REQUESTED, one FAILED with
`MoleculeOpenAIError`, one NEEDS_HUMAN with UNSAT, and one NEEDS_CLARIFICATION.
No production-plan rows, reservations or activated catalog resources were present.

A further unit mismatch was observed: a resolved capacity claim in units/day
was exposed by Reality on a capability retaining `period: week`. This requires
repair of the normalization-to-capability mapping before those records can be
treated as reliable solver inputs. Do not resolve these issues by inventing
capacity, removing conflicting evidence or silently resetting the remote database.

### Normal demo startup fails the advertised 200-kit supplier recovery

The exact README brief produced a VALID seven-node/six-edge plan at CAD 6,515.
“No polyester.”, a synthetic context attachment and approval succeeded; seven
synthetic supplier jobs were created. Taking the selected Needle North
embroidery supplier offline through the UI then produced NEEDS_HUMAN/UNSAT:
there was no quote-backed embroidery candidate.

The operational seed assigns Thread Forge capacity 400, but normal demo startup
ingests the separate mock Shopify catalog's 180. StitchWorks has conflicting
evidence. The durable integration test passes only after explicitly overriding
Thread Forge's mock capacity to 400. That passing test does not establish the
unmodified startup scenario. No supplier capacity was inflated during the browser
audit to turn the failed scenario into a pass.

### Live write paths and deployment acceptance remain open

The current environment lacks the storefront access token and supplier credential
mapping required by the live execution configuration. Shopify product/order/job
creation, live reservation/acceptance, webhook delivery and reconciliation need
identified development stores and a concrete authorized test scenario. Backboard
assistant/thread/document/memory writes also remain unverified live. Merely
having provider credentials does not establish those paths.

After the voice approval fix, a bounded live native retest transcribed both
synthetic utterances, dispatched tools, completed playback and returned to
Listening with no page errors or commerce execution. Its planning result was
NEEDS_HUMAN/UNSAT, so this is evidence of voice transport and control behavior,
not a successful live production plan. The adversarial approval check separately
uses a valid plan awaiting approval.

The service is documented as a single-operator loopback deployment. No public,
multi-tenant authorization or production deployment acceptance was performed.
`/ready` currently returns ready even with the solver unavailable; marketplace
health is more informative. The browser's voice control is intentionally disabled.

### Evaluation scores are not production accuracy

The database contains 5,022,872 imported lines: 1,032,918 originals and 3,989,954
replays. Open Food Facts prices on 107,420 products are synthetic; 4,721 UCI
prices are marked non-synthetic.

Observed stored ROX attribution and normalization scores were 60.2% and 55.5%.
They were read, not recomputed, and differ from earlier documentation. The scorer
covered 360 artifacts while the run attempted 1,144; 784 attempts had no extraction
rows and were omitted, including documents with expected claims. The 150-row
quantity holdout was model-labelled, not human-labelled. These figures cannot
support an end-to-end real-data accuracy claim.

## Browser evidence and its limits

The repository's PostgreSQL browser acceptance skill guided isolation and the
canonical scenario. Browser execution confirmed budget UNSAT, seven-node planning,
context attachment, keyboard submission, original-message persistence, cross-tab
revision updates, seven-job demo approval and prevention of repeated approval.
At 390px the document width remained 390px with reduced motion enabled.

After stopping and restarting only the isolated API process, the browser resumed
EventSource automatically at its last numeric cursor, 624, without navigation.
The persisted plan survived. Leaving the project during another outage stopped
old-project retries beyond the maximum delay, including after service restoration.
No browser JavaScript exceptions were observed.

This proves restart persistence and cursor resume, not delivery of new events
missed during downtime. The CDP stream counter included a pre-reload request
without a completion event; it is not proof of either duplicate live streams or
a verified single-stream invariant. Unit coverage and the durable SSE test are
separate evidence.

## Reproduction and evidence

Sanitized evidence and local test logs were collected under
`/private/tmp/molecule-audit-VdMNPk`. Retained copies are in
[`../.molecule-data/verification-evidence-20260919-V92Jzh`](../.molecule-data/verification-evidence-20260919-V92Jzh),
which is deliberately gitignored. Browser scripts use ports 13000/13001/18000
and only the disposable `molecule_audit_browser_20260919` database. Other newly
created databases use the `molecule_audit_*_20260919` prefix and were retained
for reproduction; no existing database was deleted.

Primary artifacts include `commerce-summary.json`, `material-audit-result.json`,
`live-kit-result.json`, `live-kit-after-material-fix-result.json`,
`provider-boundaries-summary.json`, `broad-catalog.json`, `browser/result.json`,
`browser-continuation/result.json`, and the voice evidence directories. The first
browser result intentionally records the failed supplier recovery.

## Final quality gates

| Gate                                         | Result                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository formatting and `git diff --check` | Pass                                                                                                                                                                                  |
| Uncached workspace lint/typecheck            | 33 tasks passed                                                                                                                                                                       |
| Uncached non-web production builds           | 11 packages passed                                                                                                                                                                    |
| Web production builds                        | Webpack and default Turbopack passed in isolated copies; the Turbopack copy used an explicit workspace root to resolve shared dependency symlinks. Existing dev output was preserved. |
| Final ordinary TypeScript suite              | 770 passed; 199 database-gated tests skipped in this invocation                                                                                                                       |
| Separately enabled database gates            | All 199 exercised: DB 28, events six, Reality 27, merchants 23, Shopify five, broad recipes 100, webhook ingestion three, durable runtime seven                                       |
| Unique TypeScript tests across those runs    | 969 passed; database passes were executed in isolated datasets, not inferred from the ordinary suite                                                                                  |
| Python solver                                | 90 passed; Ruff and mypy passed                                                                                                                                                       |
| ROX normalization                            | Nine pure Node tests passed, including conflicting and unsupported unit cases; syntax check passed                                                                                    |
| Client-secret scan                           | Passed for normal web/desktop outputs and isolated production web output                                                                                                              |
| Desktop/kit integration scripts              | Both passed with mock providers and real CP-SAT                                                                                                                                       |
| Native mock voice after fix                  | Ten valid-plan sessions and the injected approval attack passed, with no page errors                                                                                                  |
| Live synthetic voice after fix               | Two utterances passed transcription, tool dispatch, playback and return to Listening; UNSAT planning and no commerce receipt                                                          |
| Actual browser recovery                      | Failed as described above; no passing synthetic test overrides this result                                                                                                            |

The database-backed counts above avoid double-counting unit tests rerun alongside
integration tests. The final durable test was repeated after the inventory-ID and
action-ID changes. The 100 broad recipes use separate catalog data, actual Python
CP-SAT and mock commerce; their passing results are not live-provider acceptance.

## Continuation — 2026-09-20

This session continued the audit against the same uncommitted workspace. Remote
Tiger access remained read-only. Live Shopify and Backboard writes used isolated
local journal databases and synthetic fixtures. Provider resources from those
smokes were retained, not deleted.

### Defects addressed after the 19 September write-up

1. **Demo durable startup no longer patches Thread Forge capacity.** Release-demo
   Shopify fixtures now match the seeded 400/day operational scenario. The
   durable suite passed both 200-kit requests, supplier replacement, approval
   replay and restart persistence without a test-only capacity override. The
   standalone mock/broad catalog still uses its separate 180/day fixture.
2. **Capacity units are compared on one time basis.** `applyCapacityLimit` now
   lives in `@molecule/contracts` and is used by Reality and reservations.
   Weekly capability rows and daily winning claims are converted before a hold
   is taken. Incompatible units refuse the reservation. Remote facts were not
   rewritten.
3. **Draft-order tags were over the live 40-character limit.** Product tags
   accepted the full hash; `draftOrderCreate` rejected it. Tags are now
   `mol_act_` / `mol_trc_` plus 128 hash bits. Full keys remain in receipts and
   draft attributes. Recovery still recognizes legacy product tags.
4. **ROX scoring omitted zero-extraction documents.** Scorer `2026-09-20.1`
   scores the attempt ledger of 1,144 documents, including 784 with no
   extractions. Matching is one-to-one and requires the canonical unit. Stored
   remote scorecards were not rewritten.
5. **`GET /ready` ignored solver outages.** It now returns 503 when the solver
   health request or PostgreSQL connectivity fails. Liveness stays on `/health`.
6. **Live Shopify execution smoke.** After the tag fix, one DRAFT/untracked
   product and two OPEN unpaid drafts were created in the verified development
   store, read back by native ID, and replayed with zero additional mutations.
   No payment, completion, publish, email, inventory reservation or deletion.
7. **Live Backboard identity writes.** Isolated synthetic merchant
   `molecule-smoke-backboard-20260920-jsonout`: assistant, stale document, memory
   and replay reuse passed. Add-memory is a 201 open object without
   `created_at`; observation time is stored locally. Documents must be `indexed`
   before messaging. Completions may use `message` while `content` is null.
8. **Backboard JSON quotes need a document-free assistant.** A no-tools,
   no-document protocol probe returned valid JSON. The same `json_output` flag
   on the corpus assistant returned 26-character prose because Backboard
   ignores JSON mode when RAG/documents or tools are active. Live quotes now
   use a second `jsonAssistantId` with no tools and `memory: off`. That JSON
   turn cannot override a canonical CAN_ACCEPT with remembered prices.
   Isolated run `molecule-smoke-backboard-20260920-jsoncap` passed: lifecycle,
   protocol probe, advisory CAN_ACCEPT at CAD 12 + 10 setup, replay created
   zero extra mutating resources, reservations/jobs stayed at 0.

### Remaining live-quote blocker

Live quoting is still not production acceptance. The JSON protocol now works on
a synthetic document-free quote assistant; that is not a real merchant quote.
Local document retrieval is not remote RAG. Remote operational facts remain
uncertified.

### Disposition

Still **not ready for an unqualified real-operation sign-off.** Durable demo
recovery, Shopify development-store drafts, and Backboard identity persistence
are stronger than on 19 September. Live supplier availability, physical
fulfillment, live quoting, and remote operational facts remain uncertified.
