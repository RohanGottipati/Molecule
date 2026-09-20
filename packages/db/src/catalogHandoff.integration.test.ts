import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { PoolClient } from "pg";

import { MoleculeEventSchema } from "@molecule/contracts";

import { closePool, getPool } from "./client.js";
import { sqlDirectory } from "./migrations.js";

const database = process.env.TEST_DATABASE_URL;

describe.skipIf(!database)("catalog handoff staging", () => {
  let client: PoolClient;
  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    client = await getPool().connect();
    await client.query("begin");
    const schema = `catalog_handoff_test_${randomUUID().replaceAll("-", "")}`;
    await client.query(`create schema ${schema}`);
    await client.query(`set local search_path to ${schema}, public`);
    // Isolate the new migration from unrelated bulk/Timescale migrations.
    for (const file of ["001_core.sql", "017_broad_catalog_handoff.sql"]) {
      await client.query(await readFile(join(sqlDirectory(), file), "utf8"));
    }
  });
  beforeEach(async () => {
    await client.query("savepoint catalog_test");
  });
  afterEach(async () => {
    await client.query("rollback to savepoint catalog_test");
    await client.query("release savepoint catalog_test");
  });
  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      client.release();
    }
    await closePool();
  });

  const insertRecord = (overrides: Record<string, unknown> = {}) => {
    const values = {
      batch: "broad-network-v1",
      kind: "product",
      id: randomUUID(),
      category: "apparel",
      source: "test:catalog-delivery",
      observed: "2026-09-19T12:00:00.000Z",
      synthetic: true,
      payload: { material: { status: "unknown" } },
      trace: "catalog-handoff-test",
      action: randomUUID(),
      ...overrides,
    };
    return client.query(
      `insert into catalog_import_records
       (batch_id, record_kind, local_id, category_id, source_reference,
        observed_at, is_synthetic, payload, trace_id, action_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      Object.values({ ...values, payload: JSON.stringify(values.payload) }),
    );
  };

  it("registers targets without reporting executable catalog coverage", async () => {
    const { rows } = await client.query(
      "select * from catalog_handoff_coverage",
    );
    expect(rows).toHaveLength(12);
    expect(rows.reduce((sum, row) => sum + row.target_recipe_count, 0)).toBe(
      96,
    );
    const batch = (
      await client.query(
        "select status, metadata from catalog_import_batches where batch_id='broad-network-v1'",
      )
    ).rows[0];
    expect(batch.status).toBe("awaiting_delivery");
    expect(batch.metadata).toMatchObject({
      executable: false,
      pendingCategoryLabels: 20,
    });
  });

  it("persists a schema-valid bootstrap event", async () => {
    const event = (
      await client.query(
        `select event_id as "eventId", trace_id as "traceId", event_type as "eventType",
       ts, severity, source, payload from molecule_events
       where event_id='b8908189-d48f-4a81-8dca-8f6d9be29884'`,
      )
    ).rows[0];
    expect(
      MoleculeEventSchema.parse({ ...event, ts: event.ts.toISOString() })
        .payload,
    ).toMatchObject({ executable: false, registeredCategories: 12 });
  });

  it("preserves unknown source facts and does not create live capabilities", async () => {
    const before = await client.query("select count(*) from capabilities");
    const result = await insertRecord();
    expect(result.rows[0].payload).toEqual({ material: { status: "unknown" } });
    expect(result.rows[0].status).toBe("received");
    expect(
      (await client.query("select count(*) from capabilities")).rows,
    ).toEqual(before.rows);
  });

  it.each([
    [{ synthetic: null }, "23502"],
    [{ source: " " }, "23514"],
    [{ observed: null }, "23502"],
    [{ trace: " " }, "23514"],
    [{ category: "invented-category" }, "23503"],
    [{ batch: "missing-batch" }, "23503"],
    [{ payload: [] }, "23514"],
  ])(
    "rejects incomplete or invalid staging envelope %j",
    async (overrides, code) => {
      await expect(insertRecord(overrides)).rejects.toMatchObject({ code });
    },
  );

  it("rejects duplicate stable IDs instead of overwriting a delivery", async () => {
    const id = randomUUID();
    await insertRecord({ id });
    await expect(insertRecord({ id })).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects reuse of action keys across different records", async () => {
    const action = randomUUID();
    await insertRecord({ action });
    await expect(insertRecord({ action })).rejects.toMatchObject({
      code: "23505",
    });
  });
});
