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
    pool = new Pool({ connectionString });
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
