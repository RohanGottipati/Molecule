#!/usr/bin/env node
// Read-only measurement of what Tiger Data contributes to the Molecule workflow.
// Nothing is written: every experiment runs inside a READ ONLY transaction with a
// statement timeout, and credentials are read from the environment, never printed.
//
//   node --env-file=.env --env-file=.env.local scripts/bench/tiger-benchmark.mjs \
//     --output=.molecule-data/order6/tiger-benchmark.json [--only=risk|sales|compression|ann] [--runs=3]
//
// What each experiment answers (and its honest limits):
//   risk         Supplier p95 lead time, the number the solver consumes. Exact
//                percentile_cont over raw fulfilment samples vs the toolkit
//                percentile_agg continuous aggregate. Reports latency, the
//                aggregate's approximation error and its data coverage.
//   sales        Revenue/units by year: raw hypertable scan vs continuous aggregate.
//                Reports latency and whether the two answers are identical.
//   compression  Native compression ratio per hypertable.
//   ann          pgvector HNSW entity matching: latency, and recall against an
//                exact scan. Also whether the planner used the index at all.
//
// Timings are wall-clock over one connection on a shared service; they are
// evidence for THIS dataset on THIS day, not a general benchmark.
import { open } from "node:fs/promises";
import { connectDb, parseArgs } from "../lib/molecule-env.mjs";

const args = parseArgs();
if (!args.output)
  throw new Error("Required: --output=<new json file> (never overwritten)");
const RUNS = Number(args.runs ?? 3);
const only = args.only && args.only !== true ? String(args.only) : null;
const want = (name) => !only || only === name;

const db = await connectDb();
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** One cold run (reported separately) then RUNS warm runs. */
async function bench(sql, params = []) {
  const all = [];
  let rows = [];
  for (let i = 0; i < RUNS + 1; i++) {
    const t = process.hrtime.bigint();
    rows = (await db.query(sql, params)).rows;
    all.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const warm = all.slice(1);
  return {
    cold_ms: round(all[0]),
    warm_median_ms: round(median(warm)),
    warm_max_ms: round(Math.max(...warm)),
    warm_runs: warm.length,
    rows,
  };
}
const strip = ({ rows, ...timing }) => ({ ...timing, row_count: rows.length });

await db.query("begin read only");
await db.query("set local statement_timeout = '60s'");

const report = {
  generatedAt: new Date().toISOString(),
  runsPerQuery: RUNS,
  environment: {},
  experiments: {},
  limitations: [
    "Single connection on a shared managed service; timings vary with load and cache state.",
    "Cold runs may include cache warming by earlier experiments in the same session.",
    "Dataset is largely synthetic or replayed (see docs/DATABASE_ORDER1.md); latency does not depend on that, but no claim about real-world accuracy follows.",
  ],
};

// ---------------------------------------------------------------- environment
{
  const ext = await db.query(
    "select extname, extversion from pg_extension where extname in ('timescaledb','timescaledb_toolkit','vector','pg_trgm') order by 1",
  );
  const size = await db.query(
    "select pg_database_size(current_database())::bigint as bytes",
  );
  // approximate_row_count is stats-based and undercounts compressed chunks, so
  // the sales row count comes from the aggregate's own line counter instead.
  const rows = await db.query(
    `select (select sum(lines) from bulk_sales_daily)::bigint as bulk_order_lines_in_aggregate,
            (select approximate_row_count('fulfillment_samples'))::bigint as fulfillment_samples_approx,
            (select count(*) from rox_alias_embeddings)::bigint as alias_embeddings`,
  );
  // Network round trip from this machine to the service: the floor under every
  // latency below.
  const rtt = [];
  for (let i = 0; i < 20; i++) {
    const t = process.hrtime.bigint();
    await db.query("select 1");
    rtt.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  report.environment = {
    roundTripMedianMs: round(median(rtt), 2),
    extensions: Object.fromEntries(
      ext.rows.map((r) => [r.extname, r.extversion]),
    ),
    databaseBytes: Number(size.rows[0].bytes),
    rowCounts: Object.fromEntries(
      Object.entries(rows.rows[0]).map(([k, v]) => [k, Number(v)]),
    ),
    target: "Tiger Cloud service (host and credentials redacted)",
  };
}

// ----------------------------------------------------------------------- risk
if (want("risk")) {
  const exact = await bench(
    `select merchant_id, capability_id,
            percentile_cont(0.95) within group (order by actual_hours) as p95, count(*)::bigint as n
       from fulfillment_samples group by 1, 2`,
  );
  const cagg = await bench(
    `select merchant_id, capability_id,
            approx_percentile(0.95, rollup(pct_agg)) as p95, sum(sample_count)::bigint as n
       from lead_time_hourly group by 1, 2`,
  );
  const key = (r) => `${r.merchant_id}|${r.capability_id}`;
  const truth = new Map(exact.rows.map((r) => [key(r), r]));
  const errors = [];
  let coverageNum = 0;
  let coverageDen = 0;
  let matched = 0;
  for (const r of cagg.rows) {
    const t = truth.get(key(r));
    if (!t) continue;
    matched++;
    coverageNum += Number(r.n);
    coverageDen += Number(t.n);
    if (Number(t.p95) > 0)
      errors.push(Math.abs(Number(r.p95) - Number(t.p95)) / Number(t.p95));
  }
  // The solver's actual access pattern: one supplier/capability at a time.
  const busiest = exact.rows.reduce((a, b) =>
    Number(b.n) > Number(a.n) ? b : a,
  );
  const one = [busiest.merchant_id, busiest.capability_id];
  const exactOne = await bench(
    `select percentile_cont(0.95) within group (order by actual_hours) as p95, count(*)::bigint as n
       from fulfillment_samples where merchant_id = $1 and capability_id = $2`,
    one,
  );
  const caggOne = await bench(
    `select approx_percentile(0.95, rollup(pct_agg)) as p95, sum(sample_count)::bigint as n
       from lead_time_hourly where merchant_id = $1 and capability_id = $2`,
    one,
  );
  report.experiments.risk = {
    question:
      "Supplier p95 lead time: exact scan of raw samples vs continuous aggregate",
    allSuppliers: {
      exact: strip(exact),
      aggregate: strip(cagg),
      speedup_warm_median: round(exact.warm_median_ms / cagg.warm_median_ms),
      keysCompared: matched,
      p95_relative_error: {
        mean_pct: errors.length
          ? round((100 * errors.reduce((a, b) => a + b, 0)) / errors.length, 3)
          : null,
        max_pct: errors.length ? round(100 * Math.max(...errors), 3) : null,
      },
      sample_coverage_pct: coverageDen
        ? round((100 * coverageNum) / coverageDen, 2)
        : null,
    },
    singleSupplierLookup: {
      exact: strip(exactOne),
      aggregate: strip(caggOne),
      speedup_warm_median: round(
        exactOne.warm_median_ms / caggOne.warm_median_ms,
      ),
      exact_p95_hours: round(Number(exactOne.rows[0].p95), 2),
      aggregate_p95_hours: round(Number(caggOne.rows[0].p95), 2),
    },
    note: "Aggregate p95 is approximate (uddsketch). If coverage < 100%, the aggregate is materialized-only and misses recent rows until refreshed.",
  };
}

// ---------------------------------------------------------------------- sales
if (want("sales")) {
  const exact = await bench(
    `select extract(year from invoice_ts)::int as year,
            coalesce(sum(line_total) filter (where not is_cancel), 0) as revenue,
            coalesce(sum(quantity) filter (where not is_cancel), 0) as units
       from bulk_order_lines group by 1 order by 1`,
  );
  const cagg = await bench(
    `select extract(year from day)::int as year, sum(revenue) as revenue, sum(units) as units
       from bulk_sales_daily group by 1 order by 1`,
  );
  const byYear = new Map(cagg.rows.map((r) => [r.year, r]));
  const diffs = exact.rows.filter((r) => {
    const c = byYear.get(r.year);
    return (
      !c ||
      Math.abs(Number(c.revenue) - Number(r.revenue)) > 0.01 ||
      Number(c.units) !== Number(r.units)
    );
  });
  report.experiments.sales = {
    question:
      "Revenue and units by year: raw hypertable scan vs continuous aggregate",
    exact: strip(exact),
    aggregate: strip(cagg),
    speedup_warm_median: round(exact.warm_median_ms / cagg.warm_median_ms),
    years: exact.rows.length,
    identical_answers: diffs.length === 0,
    years_with_differences: diffs.map((r) => r.year),
  };
}

// ---------------------------------------------------------------- compression
if (want("compression")) {
  const out = {};
  for (const table of [
    "bulk_order_lines",
    "fulfillment_samples",
    "network_events",
    "market_metrics",
  ]) {
    const r = await db.query("select * from hypertable_compression_stats($1)", [
      table,
    ]);
    const s = r.rows[0] ?? {};
    const before = Number(s.before_compression_total_bytes ?? 0);
    const after = Number(s.after_compression_total_bytes ?? 0);
    out[table] = {
      chunks: Number(s.total_chunks ?? 0),
      compressed_chunks: Number(s.number_compressed_chunks ?? 0),
      before_bytes: before,
      after_bytes: after,
      ratio: before && after ? round(before / after, 2) : null,
    };
  }
  report.experiments.compression = {
    question:
      "How much does native compression shrink each hypertable (compressed chunks only)?",
    tables: out,
  };
}

// ------------------------------------------------------------------------ ann
if (want("ann")) {
  const sample = await db.query(
    `select alias, alias_kind from rox_alias_embeddings order by md5(alias || alias_kind) limit 40`,
  );
  const neighbours = `select alias_kind || ':' || alias as id from rox_alias_embeddings
                       where not (alias_kind = $2 and alias = $1)
                       order by embedding <=> (select embedding from rox_alias_embeddings where alias = $1 and alias_kind = $2)
                       limit 5`;
  const run = async (settings) => {
    await db.query(`set local enable_seqscan = ${settings.seqscan}`);
    await db.query(`set local enable_indexscan = ${settings.indexscan}`);
    const ids = [];
    const times = [];
    for (const s of sample.rows) {
      const t = process.hrtime.bigint();
      const r = await db.query(neighbours, [s.alias, s.alias_kind]);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
      ids.push(r.rows.map((x) => x.id));
    }
    const plan = await db.query(`explain ${neighbours}`, [
      sample.rows[0].alias,
      sample.rows[0].alias_kind,
    ]);
    const usedIndex = plan.rows.some((p) =>
      /idx_rox_alias_embedding_hnsw/.test(p["QUERY PLAN"]),
    );
    await db.query("set local enable_seqscan = on");
    await db.query("set local enable_indexscan = on");
    return {
      ids,
      median_ms: round(median(times), 2),
      max_ms: round(Math.max(...times), 2),
      usedIndex,
    };
  };
  const exact = await run({ seqscan: "on", indexscan: "off" });
  const planner = await run({ seqscan: "on", indexscan: "on" });
  const forced = await run({ seqscan: "off", indexscan: "on" });
  const recall = (r) =>
    round(
      (100 *
        r.ids.reduce(
          (s, got, i) =>
            s + got.filter((id) => exact.ids[i].includes(id)).length,
          0,
        )) /
        (r.ids.length * 5),
      1,
    );
  report.experiments.ann = {
    question:
      "pgvector nearest-alias search: latency and recall@5 against an exact scan",
    queries: sample.rows.length,
    aliasEmbeddings: report.environment.rowCounts.alias_embeddings,
    exactScan: { median_ms: exact.median_ms, max_ms: exact.max_ms },
    plannerDefault: {
      median_ms: planner.median_ms,
      max_ms: planner.max_ms,
      used_hnsw: planner.usedIndex,
      recall_at_5_pct: recall(planner),
    },
    hnswForced: {
      median_ms: forced.median_ms,
      max_ms: forced.max_ms,
      used_hnsw: forced.usedIndex,
      recall_at_5_pct: recall(forced),
    },
    note: "At this table size the planner may prefer a sequential scan; recall of a forced HNSW scan shows what the index would trade away at scale.",
  };
}

await db.query("rollback");
await db.end();
const handle = await open(args.output, "wx", 0o600);
await handle.writeFile(JSON.stringify(report, null, 2) + "\n");
await handle.close();
console.log(JSON.stringify(report, null, 2));
