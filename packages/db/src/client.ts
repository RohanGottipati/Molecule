import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | undefined;

/**
 * Lazily-created singleton connection pool. Reads DATABASE_URL at call time
 * (not import time) so tests can set it before the first query runs.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
      );
    }
    pool = new Pool({
      connectionString,
      max: 12,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export type DbClient = pg.Pool | pg.PoolClient;

async function runTransaction<T>(
  begin: string,
  lock: boolean,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(begin);
    if (lock) await client.query("select pg_advisory_xact_lock(73481203)");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function transaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return runTransaction("begin", true, work);
}

export async function readTransaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return runTransaction(
    "begin isolation level repeatable read read only",
    false,
    work,
  );
}
