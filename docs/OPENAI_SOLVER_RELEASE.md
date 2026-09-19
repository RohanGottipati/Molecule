# Compiler and solver release handoff

Base: `origin/devin/1789831103-final-integration`, commit
`11e822ed36796b1c91c77f01f7f147921cd3fe5e`. Changes are limited to
`packages/openai`, `services/solver`, and this document. No shared schema,
orchestration mock, dependency, or lockfile change is required.

## Interfaces and wiring

- `OpenAIAdapter.compileIntent(input: CompileIntentRequest): Promise<CompileIntentResult>`
  remains unchanged. Requests/results are validated with `@molecule/contracts`.
  Both `MockOpenAIAdapter` and `RealOpenAIAdapter` implement it.
- `RealOpenAIAdapterOptions` remains `{ apiKey, compilerModel?, realtimeModel?,
transcriptionModel?, timeoutMs?, client? }`. Existing server configuration
  (`USE_MOCK_OPENAI`, `OPENAI_API_KEY`, `OPENAI_COMPILER_MODEL`,
  `OPENAI_REALTIME_MODEL`) continues to work; do not put keys in the client.
- Existing optional `extractClaims`, `mintRealtimeClientSecret` and
  `uploadContext` interfaces are unchanged.
- `mapExtractionToResult(extraction: IntentExtraction, previousIntent:
ProductIntentDraft | undefined, assets: AssetRef[]): CompileIntentResult`
  remains exported. `intentGraphIssues(intent: ProductIntentDraft): string[]`
  is a new exported semantic graph validator. It **cannot certify feasibility**.
- `IntentExtractionSchema`, `IntentExtraction`,
  `INTENT_COMPILER_INSTRUCTIONS`, and `INTENT_PROMPT_VERSION` remain exported.
  `ExtractionValueSchema` is now exported for mock extraction validation.
  Extraction schemas are provider transport schemas; domain schemas still come
  from `@molecule/contracts`.
- Python `app.cpsat.solve(data: SolverInput) -> ProductionPlan` and
  `POST /solve` retain their existing JSON contracts. `GET /health` is unchanged.
  Only a feasible CP-SAT solution passing graph validation returns `VALID`.

Parent wiring: pass the **entire** compiled intent, full candidate pool, and one
current accepted quote per capability to the Python service. Validate the returned
plan with `ProductionPlanSchema`. A compiler result of `READY` means the intent
is structured; it does not mean production is feasible. Persist compiler/solver
events and explanations in the orchestrator, without model reasoning. This
package has no database or event persistence API.

When recovering, mark the offline merchant's candidates blocked or remove them,
retain the other components and current quotes, increment `generation`, and send
the previous node IDs as `changePenaltyNodeIds`. Do not group candidates by
capability kind or reduce each kind to one entry before calling the solver.

## Requirement graph

Each desired output is one procurement requirement; `output.quantity` overrides
`intent.quantity`. Each transformation is one service requirement. The following
is the acceptance request's graph:

```text
hoodie -> embroidery -> embroidered-hoodie -----\
bottle -> engraving  -> engraved-bottle --------> assembly -> packaged-kit
snacks ---------------------------------------/                 |
                                                           fulfillment
                                                                |
                                                          delivered-kit
```

Supply `outputId`s are `hoodie`, `bottle`, `snacks`, not an extra purchased `kit`.
Transformation IDs are `embroidery`, `engraving`, `assembly`, `fulfillment`.
Every intermediate `outputRef` must be unique. Do not transform `hoodie` into
`hoodie` in place. `inputRefs` reference a supply output or a preceding
transformation's output, never an unproduced placeholder.

TRANSFORM and FULFILL quantities follow their inputs; inputs with different
quantities require clarification. ASSEMBLE uses `intent.quantity`; every input
quantity must be a positive whole multiple of that quantity (e.g. 200 hoodies
can supply two per 100 kits). Multiple consumption of the same output, implicit
split allocations, cycles, duplicate IDs, and missing producers are rejected.
Explicit component allocation would require a future shared contract extension.
For multiple outputs on a service, its produced port names must identify the
specific output references. Existing contracts have no per-port quantity ratios.

Node IDs are `node-{requirementId}-{capabilityId}`; there can be multiple nodes
of any kind. Each graph edge represents the actual reference, upstream quantity,
and capability quantity unit. Independent supply/transform nodes may run in
parallel. Reusing a capability schedules non-overlapping work and aggregates
its inventory/quote quantity limits.

## Exact catalog and quote conventions for Tiger/Rox

All IDs and numbers below describe **synthetic deterministic test fixtures**,
not verified external inventory or merchant promises. The executable reference is
`services/solver/tests/test_requirements.py::kit_payload`.

| Capability ID | Merchant ID  | Kind      | CAD/unit | Accepted products                                                         | Produced product/attributes                           |
| ------------- | ------------ | --------- | -------: | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| hoodie        | base-goods   | SUPPLY    |       12 | none                                                                      | hoodie, material=cotton, color=black                  |
| bottle        | base-goods   | SUPPLY    |        5 | none                                                                      | bottle, material=stainless steel                      |
| snacks        | snack-box    | SUPPLY    |        3 | none                                                                      | snacks, material=plant, diet=vegan                    |
| stitch        | stitch-works | TRANSFORM |        4 | hoodie                                                                    | hoodie, operation=embroidery, material=cotton         |
| thread        | thread-forge | TRANSFORM |      4.5 | hoodie                                                                    | hoodie, operation=embroidery, material=cotton         |
| needle        | needle-north | TRANSFORM |      5.1 | hoodie                                                                    | hoodie, operation=embroidery, material=cotton         |
| laser         | laser-lab    | TRANSFORM |      3.2 | bottle                                                                    | bottle, operation=engraving, material=stainless steel |
| pack          | pack-ship    | ASSEMBLE  |        2 | hoodie with operation=embroidery; bottle with operation=engraving; snacks | kit, packaging=individual                             |
| ship          | pack-ship    | FULFILL   |        2 | kit with packaging=individual                                             | kit                                                   |

All ports use `kind: "product"`, `unit: "units"` and
`attributes.product` equal to the canonical product. Supply identity is matched
case-insensitively using `attributes.product`, falling back to the port name.
Every requested attribute must be known and equal on the produced supply port.
TRANSFORM operation identity uses `attributes.operation`, the port name, or the
exact capability name. Explicit product and operation attributes are recommended.
No fuzzy semantic matching is performed by the solver.

Downstream input ports must match upstream kind, product, unit and every declared
accepted attribute. Every declared input port must be supported by an actual
upstream requirement. Unsupported unit conversion is rejected. Capability
quantity units and produced port units must agree.

Fixture quantities are 1–500 units. Supply `capacity.available=500` means
inventory, even if a period is present. Service capacity is throughput when a
period is present: use `available=500, maximum=500, period="day"` for the
verified synthetic alternatives. Without a period, service available capacity
is an absolute quantity limit. An optional `produces[].attributes.inventory`
also caps the total selected quantity.

StitchWorks' selected effective throughput is **20/day**, making 200 units
take at least ten days. Preserve its historical 100/day web claim, 50/day document
claim and fresh 20/day outage evidence upstream. Do not average them or overwrite
the history. Only the resolved, authoritative effective fact belongs in the
canonical capability; if resolution is still conflicted, pass `available=null`
or a `blockedReasons` entry. The current contracts do not carry evidence
resolution status directly into the solver.

Fixture lead-time maximum and p95 are both 12 hours. Service duration is the
maximum of lead-time max, known p95, and quantity / throughput × period.
All work uses elapsed calendar time. `business_hours` candidates are rejected
because no working calendar is present in the shared contracts. Unknown p95
adds objective fragility; the known contractual lead-time max still applies.
`capacity.asOf` cannot be in the future. Upstream owns freshness policy.

Quotes must identify both the merchant and capability, have `CAN_ACCEPT`,
no required changes, a known nonnegative `unitPrice`, matching currency and a
sufficient `maxQuantity` when present. Duplicate, mismatched and orphan quotes
cannot certify. A completion estimate is a lower bound on the node's completion;
it cannot shorten its modeled duration. The quote is the negotiated price:
node cost is `max(unitPrice * requirementQuantity + setupFee, minimumTotal)`,
rounded upward to cents. Setup/minimum apply per requirement job. Add CAD 40
setup to the laser quote. Unknown price is never treated as zero.

With planning time `2026-09-19T12:00:00Z`, 200 kits have:

- Initial selected embroidery: thread-forge; total **CAD 6,380**.
- With no polyester: still **CAD 6,380**.
- After thread-forge is blocked: needle-north; total **CAD 6,500**.
- Both schedules complete in 48 hours with the supplied synthetic facts, before
  Friday's local end of day. StitchWorks is excluded by throughput/deadline.

## Constraints, compilation and correction behavior

`hoodie.color`, `hoodie.material`, and `snacks.diet` scope to the requirement ID
or product identity. `assembly.packaging=individual` scopes to the assembly
operation. Global material exclusions apply to SUPPLY and TRANSFORM produced
goods: include known material on embroidery and engraving outputs, including
thread/material blends. Unknown, conflicted, null and unresolved values do not
satisfy exclusions. Kit assembly and fulfillment do not require a fictitious
single kit material.

Merchant hard rules are also enforced; quantity/currency/capacity use known
request/candidate values, material/product rules use explicitly requested
component attributes, and `assets` can require supplied asset IDs. Unknown
merchant requirements exclude that candidate. Do not encode an unsupported
merchant policy as prose and assume it was enforced.

Supported hard operators are eq/neq/lt/lte/gt/gte/in/contains/not_contains;
unsupported operators fail HTTP validation. Plan-wide budget/totalCost and
deadline constraints use numeric/date comparisons; unsupported combinations or
component-scoped plan-wide fields fail closed. Explicit quantity units must
match the capability; cost units must match currency. Unknown constraints never
silently become true. Soft preferences affect selection without making a
feasible plan UNSAT.

The deterministic mock recognizes hoodies, bottles, snacks, shirts, totes, mugs,
notebooks, hats and jackets, and embroidery, engraving, printing, assembly,
individual packaging and delivery. Unrecognized component clauses/qualifiers
ask clarification. It is not a general language model. An unspecified
preassembled kit remains one catalog procurement requirement; component kits
are expanded only from components actually mentioned.

The mock preserves per-component quantities, artwork references, vegan/no-leather
requirements and scoped color. Premium and explicit preferences are soft until
the customer supplies measurable criteria. "No polyester" adds an exclusion
without removing no leather, replacing components, dropping operations, or
losing assets. Both adapters preserve prior IDs and omitted prior components,
operations, preferences and assets on additive corrections. Explicit removals
should use the parent-owned structured constraint/removal workflow.

Operations are associated by clause rather than by adjacency, so "hoodie logo
embroidery", "hoodies with embroidered logo" and "logo on hoodie" all target the
single component named in that clause; a clause naming several or no components
falls back to the only requested component, otherwise it asks which component
needs the operation. A detached color clause in a kit request ("... , black, ...")
scopes to the requested wearable; unsupported components and qualifiers such as
"logo on umbrellas" or "matte black" still ask for clarification.

The Python solver runs as a subprocess in the package integration test. Each
solve is bounded at 20s and `packages/openai/vitest.config.ts` sets a 30s
`testTimeout`, which covers hosted-runner CPU contention without relaxing any
assertion; locally the complete-kit test takes about 2s and about 6s under
four competing busy loops on two cores.

Relative dates use `requestedAt` and the caller's IANA time zone. "Friday"
means the upcoming occurrence, including today; "next Friday" on Friday means
seven days later. No specified time means local 23:59:59, including DST changes.
The mock retains the existing explicit ISO date-only convention of 23:59:59 UTC.
The real compiler receives the same relative-date policy in its instructions.
For the acceptance fixture, Toronto Friday is `2026-09-26T03:59:59.000Z`.

## OpenAI API boundary

Official references consulted:

- <https://developers.openai.com/api/docs/guides/structured-outputs>
- <https://developers.openai.com/api/reference/resources/responses/methods/create>
- <https://developers.openai.com/api/docs/guides/pdf-files>

Responses uses `responses.parse` with `text.format =
zodTextFormat(IntentExtractionSchema, "product_intent")`. Every extraction
object is strict, all fields are required (nullable where needed), and the
result is validated again before domain mapping. The compiler has no execution
tools and an output budget of 6,000 tokens. Descriptions/questions are bounded.
`store:false`, trace metadata, a hashed safety identifier, explicit timeout and
deterministic attempt request headers are included. Parent persistence remains
the authoritative idempotency/event mechanism.

Exactly one semantic/JSON/schema repair is attempted, including SDK parse
exceptions. A second failure is a typed visible `VALIDATION` error; refusal,
timeout, failed or incomplete provider responses cannot become a mock success.
Images use `input_image` with URL/file ID; other files use `input_file` with
file URL/ID. Prior asset references are retained on correction. No private
reasoning is requested or exposed.

## Verification and remaining acceptance

Run from the repository root after the existing Python virtual environment
and workspace dependencies are installed:

```bash
pnpm --filter @molecule/contracts build
pnpm exec prettier --check packages/openai/src docs/OPENAI_SOLVER_RELEASE.md
pnpm --filter @molecule/openai lint
pnpm --filter @molecule/openai typecheck
pnpm --filter @molecule/openai test
pnpm --filter @molecule/openai build
services/solver/.venv/bin/ruff format --check services/solver
pnpm solver:lint
pnpm solver:test
services/solver/.venv/bin/python -m compileall -q services/solver/app
```

The OpenAI release tests execute the actual Python solver subprocess and
validate its JSON using the canonical TypeScript schema, covering initial
compilation, correction and supplier-offline recovery. Thus this test suite
requires `services/solver/.venv` (existing solver dependencies, no new packages).
Python tests additionally exercise the FastAPI HTTP validation boundary and
adversarial quotes, quantities, ports, inventory, risk, budgets and graph input.
Existing tests are unchanged.

No provider credentials were supplied, so live Responses/Realtime/merchant/
commerce acceptance has not run. There is no claim of physical microphone,
voice interruption, external inventory, or real fulfillment verification.
Browser/UI recording, database/event integration, final candidate data wiring,
full-stack smoke and the single final PR belong to the parent session.
