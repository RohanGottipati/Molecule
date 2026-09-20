# Order 6: what Tiger contributes

Status: **measured live, read-only, on 2026-09-20 UTC.** Evidence:
[`order6-tiger-benchmark.json`](evidence/order6-tiger-benchmark.json). Rerun with
[`scripts/bench/tiger-benchmark.mjs`](../scripts/bench/tiger-benchmark.mjs).

Environment: Tiger Cloud, PostgreSQL 18, TimescaleDB 2.30, toolkit 1.26,
pgvector 0.8.6. About 5.0M order lines and 1.2M fulfillment samples; median round
trip ~29 ms. One connection on a shared service, 2-3 runs per query, so timings
are indicative. The data is largely synthetic or replayed
([Order 1](DATABASE_ORDER1.md)); latency does not depend on that, but nothing
here says anything about real-world accuracy.

## Results

| Question                             | Raw / exact      | Tiger feature                                  | Speedup     | Caveat                                                                                 |
| ------------------------------------ | ---------------- | ---------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| Revenue and units by year            | 8.2 s            | continuous aggregate `bulk_sales_daily`: 42 ms | **196x**    | Answers identical for all 12 years                                                     |
| p95 lead time, all 227 suppliers     | 3.1 s            | `lead_time_hourly` + `percentile_agg`: 1.7 s   | **1.8x**    | Approximate: mean error 0.8%, max 1.6%                                                 |
| p95 lead time, one supplier          | 31 ms            | same aggregate: 29 ms                          | 1.1x        | No benefit; dominated by network round trip                                            |
| Nearest alias (pgvector, 40 queries) | 32 ms exact scan | HNSW forced: 32 ms                             | none        | Recall@5 100% both ways. Only 459 vectors; planner correctly prefers a sequential scan |
| Storage                              | 1.29 GB / 352 MB | native compression                             | 6.7x / 9.9x | Compressed chunks only; `network_events` and `market_metrics` are not compressed       |

## What to claim, and what not to

Supported: continuous aggregates turn a multi-second scan over millions of rows
into a tens-of-milliseconds read with an identical answer, and compression cuts
hypertable storage roughly 7-10x.

Not supported: any claim that Tiger speeds up single-supplier lookups or vector
search at the current size. Say instead that the HNSW index is in place and
recall is unaffected, and that its latency value appears only at much larger
scale.

Not measured here: matching quality attributable to Tiger (see
[Order 4](DATABASE_ORDER4.md): trigram and exact matching do the work; vector
and LLM matching are not the source of the attribution results), and
replay/recovery timing.

## Not done

- Replay/recovery behaviour: covered by the existing durable tests, not re-measured.
- Concurrency or load. All measurements are single-connection.
- The aggregate p95 covers 100% of samples now; it would miss rows not yet
  materialized if data kept arriving.
