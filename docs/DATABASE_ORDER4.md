# Order 4: supplier attribution and capacity normalization

Status: **implemented and tested against the synthetic corpus; not validated on real documents.**

Order 3 has no authorized real documents yet (see [Order 3](DATABASE_ORDER3.md)).
Everything below was driven by the frozen synthetic snapshot from Order 1
(1226 artifacts, 691 truth rows, 724 extractions), not by the real-document
benchmark the order calls for. Treat the numbers as a regression baseline, not
as real-world accuracy.

## What changed

**Capacity is interpreted under an explicit uncertainty policy**
([`capacity.mjs`](../rox_data/pipeline/capacity.mjs)). A capacity claim becomes a
comparable `units/day` value only when its source says so. Otherwise it is
refused with a reason code and routed to review:

| Situation                                     | Outcome                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Number with no period (`"500"`)               | `needs_review: no_period`                                        |
| Whole-batch quantity, not a rate              | `needs_review: absolute_batch`                                   |
| Hourly rate                                   | `needs_review: hourly_rate`                                      |
| Range, "up to", "at least", "if/subject to"   | `needs_review` (range / upper_bound / lower_bound / conditional) |
| Stated period contradicts the evidence        | `needs_review: period_conflict`                                  |
| A revised figure that only inherits a period  | `needs_review: period_inherited`                                 |
| Effective window expired, future, or inverted | `needs_review: window_*`                                         |
| Unreadable or negative                        | `quarantine`                                                     |

A source timestamp is never treated as an effective date, and "available",
"capacity" and "inventory" stay separate facts. Refusals land in
`rox_review_queue` with `ask_supplier_to_clarify`, so uncertainty is retained
rather than discarded.

**Supplier attribution** ([`attribution.mjs`](../rox_data/pipeline/attribution.mjs))
picks the capability a fact is about from its own supplier's capabilities, using
exact name, term overlap, then trigram similarity (minimum 0.25, minimum margin
0.05). When the choice is not clear it leaves the capability empty and queues a
`low_confidence_link` review item rather than guessing.

The old parser is reachable only inside `pipeline/compare-policies.mjs` to
reproduce historical synthetic scores. Runtime ingestion has no legacy-policy
environment switch.

## Measured effect (synthetic corpus, 334 capacity extractions)

Evidence: [`order4-capacity-policy-comparison.json`](evidence/order4-capacity-policy-comparison.json).

|                | Legacy | Strict |
| -------------- | ------ | ------ |
| Correct claims | 242    | 100    |
| Wrong claims   | 69     | 0      |
| Sent to review | 0      | 214    |

Strict sends 147 values the truth says were right to review (138 with no stated
period, 9 with an inherited period). In exchange it stops 64 of the 69 wrong
claims and corrects the other 5. **This lowers recall by design.** The 69 wrong
legacy claims were almost all warehouse-system feeds (59) reporting bare numbers
that were silently read as per-day. Which policy is right for the demo is a
product decision, not a technical one.

Attribution ([`order4-matching-quality.json`](evidence/order4-matching-quality.json)):
of 592 unattributed-or-attributed extractions, 154 remain unattributed
(merchant-level alias resolution is not addressed). Among the 438 attributed,
merchant and capability precision lies between **79.5% and 94.5%**. The range is
wide because the benchmark pairs extractions to truth by value, which is
ambiguous when two capabilities share a number (59 pairs). The gap is in the
benchmark, not evidence about the pipeline.

## Follow-up status

- No real-document accuracy. Requires Order 3 inputs.
- 154 unattributed extractions need merchant-alias resolution.
- Migration 022 and the ROX resolver now persist run-specific resolution
  snapshots. New-run outlier accuracy is reproducible; historical runs without
  those rows remain explicitly uncertified.
- The extraction prompt is now `rox-extract-v4`; extractions made under v3 are
  not re-run, so live Tiger rows were not re-normalized.

## Verify

```sh
cd rox_data && npm test
node pipeline/compare-policies.mjs --snapshot ../.molecule-data/order1/historical-snapshot.json --output /tmp/cmp.json
```
