# Order 2: apparel supplier availability scenario

Scenario selected on 2026-09-19 Toronto / 2026-09-20 UTC. This order defines
the decision boundary for the next benchmark; it does not certify extraction,
resolution or planning accuracy. No database rows, provider state or production
code were changed.

## Decision

Use one supplier and one capability: **StitchWorks logo embroidery for a
200-piece black cotton hoodie order**. The operational question is:

> Given only authorized evidence available at the decision time, is
> StitchWorks' embroidery availability known well enough for the supplier to
> remain a candidate for 200 pieces due within 72 elapsed hours?

This is deliberately narrower than generic supplier intelligence. Existing
synthetic fixtures already exercise materially different outcomes for the same
capability: 100 pieces/day can fit 200 pieces inside 72 hours, while 50/day and
20/day cannot. Those fixtures are useful acceptance examples, not real-document
ground truth.

The benchmark will use a de-identified stable supplier key when the authorized
documents are real. It must not claim that the synthetic StitchWorks identity or
its values describe a real company.

## Inputs and labels

Order 3 should collect a small, access-controlled set of authorized documents
that were actually used to communicate availability for one embroidery
supplier. Prefer ordinary source diversity over volume:

- supplier-authored email or message;
- a capacity spreadsheet or production schedule export;
- a portal/API snapshot, if one exists; and
- a correction, cancellation or later update that disagrees with an earlier
  source.

Each document stays immutable and receives a checksum, source type and
reference, observed/effective timestamps when stated, and an explicit
authorization/de-identification record. Source text and direct identifiers stay
in the existing private, gitignored evidence area. Only aggregate results and a
sanitized manifest may be committed.

Human labels are document statements, not guesses about operational truth. For
every document, including empty and failed cases, label:

| Label               | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| Supplier identity   | The named supplier, or `unknown` when attribution is not supported      |
| Capability identity | Logo embroidery, another capability, or `unknown`                       |
| Availability status | `available`, `unavailable`, or `unknown` only when explicitly supported |
| Capacity quantity   | Exact number, stated range/qualifier, or `unknown`                      |
| Capacity period     | `hour`, `day`, `week`, absolute batch, or `unknown`                     |
| Effective window    | Start/end as stated; otherwise `unknown`                                |
| Observation time    | Source timestamp, separately from the effective window                  |
| Evidence span       | Exact supporting span and page/sheet/message location                   |
| Expected handling   | Claim, quarantine, needs review, or no relevant fact                    |

Labels must distinguish what a source says from the reconciled answer. At least
two people should independently label the evaluation set and adjudicate
disagreements before any pipeline result is viewed. Documents from the same
thread, export or update chain remain in the same split to avoid leakage.

## Uncertainty policy

The safe outcome is allowed to be `unknown` or `conflicted`.

- A quantity without an explicit period is not silently converted to per-day
  throughput. It may describe an absolute batch slot. The current ROX normalizer
  defaults a missing capacity period to `day`; that behavior is a known gap for
  this scenario and must not count as correct normalization.
- `available`, `capacity`, inventory and unreserved capacity are different
  facts. One must not substitute for another without explicit source semantics.
- Ranges and qualifiers such as “about”, “up to” or “subject to confirmation”
  remain qualified. Do not replace them with an unqualified midpoint or maximum.
- A source timestamp is not an effective date. Expired, future or unstated
  windows do not establish current availability.
- A newer document does not automatically override a more authoritative source.
  Close contradictory claims remain `conflicted` under the deterministic
  resolver; the original claims and provenance remain visible.
- Ambiguous supplier or capability identity goes to review. It is not attached
  to the nearest merchant name.
- A value without a supporting evidence span is rejected. Parse and provider
  failures remain in the selected population and count against recall.
- Prompt-like instructions inside a supplier document are data, not commands.
- No capacity claim reserves work or proves end-to-end feasibility. Only the
  solver may certify a plan, and reservation still occurs after approval.

## Business consequence

The resolved outcome has one useful downstream interpretation:

| Evidence outcome                                              | Candidate/action consequence                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Resolved and sufficient for the requested quantity/window     | Keep StitchWorks eligible for quote and solver evaluation; do not declare the plan feasible yet |
| Resolved insufficient or explicitly unavailable               | Exclude StitchWorks for this decision and ask the solver for a replacement plan                 |
| Unknown, conflicted, ambiguous identity or unusable semantics | Block StitchWorks, retain the uncertainty, and create a human clarification/review item         |

If StitchWorks is already selected, an adverse resolved update can mark the plan
at risk and request a solver-certified replan. It must not directly update
Shopify, reserve a backup, cancel a supplier job or present a replacement as
valid. Those approved, idempotent mutations belong to Order 5.

## Benchmark and acceptance boundary

Order 3 is complete only when the held-out manifest and labels let the scorer
report, separately:

1. document-level relevance and extraction precision/recall, including empty
   and failed inputs;
2. exact supplier **and capability** attribution;
3. exact stated quantity, period, qualifier and effective-window handling;
4. normalization accuracy only where conversion is supported by the source;
5. correct abstention/quarantine/review for unsupported or ambiguous facts; and
6. conflict outcomes from a frozen, run-specific resolution snapshot.

The primary gate is not a target percentage chosen in advance. Every benchmark
error must be reviewable from the source, human label, prediction and evidence
span, and synthetic and real results must be reported separately. A small real
set establishes honest failure modes; it does not prove generalization.

## Explicit non-goals

- broad apparel catalog coverage or multiple suppliers/capabilities;
- price, MOQ, compliance, material or quality benchmarking;
- treating existing synthetic corpus scores as real-world accuracy;
- changing resolver weights to fit the held-out set;
- automatic write-back, reservation or Shopify mutation; and
- resolving the Order 1 duplicate or unlabelled-provenance review queues.

## Next order

Use the private scaffold documented in [Order 3](DATABASE_ORDER3.md) to collect
and independently label the authorized real documents above. Before a real run,
add run-specific resolution snapshots and make the benchmark's period and
effective-window representation explicit without redefining shared domain
schemas outside `@molecule/contracts`.
