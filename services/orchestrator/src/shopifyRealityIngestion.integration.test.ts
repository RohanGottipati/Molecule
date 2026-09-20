import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool, getPool, migrate, seedDemo } from "@molecule/db";

const database = process.env.TEST_DATABASE_URL;

describe.skipIf(!database)("Shopify resource-scoped ingestion", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    process.env.DEMO_MODE = "true";
    await migrate();
    await seedDemo();
  });

  afterAll(closePool);

  it("has no active merchant-wide Shopify capacity claims", async () => {
    const result = await getPool().query<{ count: string }>(
      `select count(*)::text as count from canonical_claims
       where source_kind='shopify' and field='capacity_per_day'
         and resolution_status <> 'superseded'`,
    );

    expect(result.rows[0]?.count).toBe("0");
  });
});
