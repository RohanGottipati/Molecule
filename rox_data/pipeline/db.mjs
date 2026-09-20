// Database access for the Rox pipeline. Thin on purpose: one client, typed-ish
// helpers, and the run/event/cost bookkeeping every stage shares.

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stableJson } from "@molecule/resolution";

import { BUDGET_USD, FALLBACK_PRICES } from "./config.mjs";

const require = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), "..", "x.js"),
);
const pg = require("pg");

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const shortId = (...parts) => sha256(parts.join("|")).slice(0, 24);
export const maskUrl = (u) =>
  String(u).replace(/(:\/\/[^:]*:)[^@]*@/, "$1****@");

/** Server-side disconnects and transport failures, all of them retryable. */
const TRANSIENT = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "40001",
  "40P01",
]);
const TRANSIENT_MESSAGES =
  /ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|socket hang up|server closed the connection/i;
export const isTransient = (error) =>
  TRANSIENT.has(error?.code) ||
  TRANSIENT_MESSAGES.test(String(error?.message ?? ""));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A pool, not a client: extraction runs several artifacts at once and pg refuses
 * concurrent queries on a single connection.
 *
 * A managed database restarts, fails over and reaps idle connections whenever it
 * likes - a run over a thousand documents will meet that at least once. Two
 * things follow: an idle client's error must never reach `process.on
 * ('uncaughtException')`, and a query killed mid-flight must be retried rather
 * than lost. Every stage is idempotent (deterministic ids, `on conflict do
 * nothing`), so retrying is safe.
 */
export async function connect({ max = 8, retries = 5 } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(
      "DATABASE_URL is not set (run with --env-file=../.env --env-file=../.env.local)",
    );
  const pool = new pg.Pool({
    connectionString: url,
    max,
    keepAlive: true,
    idleTimeoutMillis: 30_000,
  });

  // Without this, a dropped idle connection is an unhandled 'error' event and
  // the process dies holding a half-finished run.
  pool.on("error", (error) => {
    console.warn(
      `  db: idle connection dropped (${error.code ?? error.message}); the pool will reconnect`,
    );
  });

  const query = pool.query.bind(pool);
  pool.query = async (...queryArgs) => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await query(...queryArgs);
      } catch (error) {
        lastError = error;
        if (!isTransient(error) || attempt === retries) throw error;
        const wait = Math.min(8000, 250 * 2 ** attempt);
        console.warn(
          `  db: ${error.code ?? error.message}, retrying in ${wait}ms (attempt ${attempt + 1}/${retries})`,
        );
        await sleep(wait);
      }
    }
    throw lastError;
  };

  await pool.query("select 1");
  return pool;
}

/** Runs fn inside one transaction on a single pooled connection. */
export async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Canonical JSON. Shared with the Reality service via @molecule/resolution. */
export { stableJson };

// ------------------------------------------------------------------ runs

export async function startRun(
  db,
  { batchId, seed, mode = "real", models = {}, budget = BUDGET_USD },
) {
  const runId = `rox-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  await db.query(
    `insert into rox_ingest_runs (run_id, batch_id, seed, mode, models, budget_usd) values ($1,$2,$3,$4,$5,$6)`,
    [runId, batchId, seed ?? null, mode, models, budget],
  );
  return runId;
}

export async function bumpStage(db, runId, stage, counts) {
  await db.query(
    `update rox_ingest_runs
        set stage_counts = jsonb_set(stage_counts, array[$2], coalesce(stage_counts->$2, '{}'::jsonb) || $3::jsonb, true)
      where run_id = $1`,
    [runId, stage, JSON.stringify(counts)],
  );
}

export async function finishRun(db, runId, status = "completed", error = null) {
  await db.query(
    `update rox_ingest_runs set status=$2, error=$3, finished_at=now() where run_id=$1`,
    [runId, status, error],
  );
}

// ------------------------------------------------------------------ events

/** Events require a uuid-shaped id; derive one so replays are idempotent. */
export function uuidFrom(key) {
  const h = sha256(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function emitEvent(
  db,
  { traceId, type, severity = "INFO", merchantId = null, payload = {} },
) {
  const eventId = uuidFrom(`${traceId}:${type}:${stableJson(payload)}`);
  await db.query(
    `insert into molecule_events (event_id, trace_id, merchant_id, event_type, severity, source, ts, payload)
     values ($1,$2,$3,$4,$5,'rox', now(), $6) on conflict (event_id) do nothing`,
    [eventId, traceId, merchantId, type, severity, payload],
  );
}

// ------------------------------------------------------------------ cost

let priceCache = null;
async function prices(db) {
  if (priceCache) return priceCache;
  const { rows } = await db.query(
    `select model, input_per_mtok, cached_per_mtok, output_per_mtok from rox_model_prices`,
  );
  priceCache = Object.fromEntries(
    rows.map((r) => [
      r.model,
      {
        input: Number(r.input_per_mtok),
        cached: Number(r.cached_per_mtok ?? r.input_per_mtok),
        output: Number(r.output_per_mtok),
      },
    ]),
  );
  return priceCache;
}

export function estimateCost(model, usage, table = FALLBACK_PRICES) {
  const p = table[model] ??
    FALLBACK_PRICES[model] ?? { input: 5, cached: 5, output: 15 };
  const cached = usage.cached_tokens ?? 0;
  const fresh = Math.max(0, (usage.input_tokens ?? 0) - cached);
  return (
    (fresh * p.input +
      cached * p.cached +
      (usage.output_tokens ?? 0) * p.output) /
    1_000_000
  );
}

/** Records one model call and returns the run's spend so far. */
export async function meter(
  db,
  runId,
  {
    stage,
    model,
    usage = /** @type {{input_tokens?: number, cached_tokens?: number, output_tokens?: number}} */ ({}),
    latencyMs,
    ok = true,
    error = null,
  },
) {
  const table = { ...FALLBACK_PRICES, ...(await prices(db)) };
  const cost = estimateCost(model, usage, table);
  await db.query(
    `insert into rox_llm_calls (call_id, run_id, stage, model, input_tokens, cached_tokens, output_tokens, cost_usd, latency_ms, ok, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      randomUUID(),
      runId,
      stage,
      model,
      usage.input_tokens ?? 0,
      usage.cached_tokens ?? 0,
      usage.output_tokens ?? 0,
      cost,
      latencyMs ?? null,
      ok,
      error,
    ],
  );
  const { rows } = await db.query(
    `update rox_ingest_runs set cost_usd = cost_usd + $2 where run_id = $1 returning cost_usd, budget_usd`,
    [runId, cost],
  );
  return {
    cost,
    spent: Number(rows[0].cost_usd),
    budget: Number(rows[0].budget_usd ?? BUDGET_USD),
  };
}

export class BudgetExceeded extends Error {
  constructor(spent, budget) {
    super(
      `Budget ceiling reached: $${spent.toFixed(4)} of $${budget.toFixed(2)}`,
    );
    this.name = "BudgetExceeded";
  }
}
