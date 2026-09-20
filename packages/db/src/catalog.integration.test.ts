import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activateCatalog, importCatalog, readCatalog } from "./catalog.js";
import { closePool, getPool } from "./client.js";
import { migrate } from "./migrations.js";

const database = process.env.TEST_DATABASE_URL;
const evidence = {
  observedAt: "2026-09-19T00:00:00Z",
  sourceReference: "test:catalog",
  synthetic: true,
};
function fixture(version: string, name = "Test merchant") {
  return [
    {
      recordType: "manifest",
      schemaVersion: 1,
      catalogVersion: version,
      createdAt: evidence.observedAt,
      categories: ["Apparel"],
      complete: true,
      recordCounts: {
        merchant: 1,
        product: 0,
        variant: 0,
        family: 0,
        resource: 1,
        fact: 0,
        binding: 0,
        recipe: 0,
      },
    },
    { recordType: "merchant", id: "catalog-test-merchant", name, evidence },
    {
      recordType: "resource",
      id: "catalog-test-stock",
      merchantId: "catalog-test-merchant",
      kind: "inventory",
      unit: "units",
      availability: { status: "known", value: 50 },
      evidence,
    },
  ]
    .map((x) => JSON.stringify(x))
    .join("\n");
}
describe.skipIf(!database)("immutable catalog versions in PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    await migrate();
  });
  afterAll(closePool);
  it("imports idempotently, refuses mutation and atomically rolls back without restoring stale stock", async () => {
    const version = randomUUID();
    const next = randomUUID();
    await importCatalog(fixture(version), "test");
    await importCatalog(fixture(version), "test-retry");
    expect(await readCatalog(version, getPool())).toHaveLength(2);
    await expect(
      importCatalog(fixture(version, "Changed"), "test"),
    ).rejects.toThrow("IMMUTABLE");
    await activateCatalog(version, "test", `activate:${version}`);
    await getPool().query(
      "update catalog_resource_state set available=2,observed_at='2026-09-20' where resource_id='catalog-test-stock'",
    );
    await importCatalog(fixture(next), "test");
    await activateCatalog(next, "test", `activate:${next}`);
    await activateCatalog(version, "test", `rollback:${version}`);
    expect(
      (
        await getPool().query(
          "select catalog_version from catalog_active_version",
        )
      ).rows[0].catalog_version,
    ).toBe(version);
    expect(
      Number(
        (
          await getPool().query(
            "select available from catalog_resource_state where resource_id='catalog-test-stock'",
          )
        ).rows[0].available,
      ),
    ).toBe(2);
    await expect(
      activateCatalog(next, "test", `rollback:${version}`),
    ).rejects.toThrow("ACTION_KEY_CONFLICT");
    await expect(activateCatalog("missing", "test", "missing")).rejects.toThrow(
      "UNKNOWN_CATALOG_VERSION",
    );
    expect(
      (
        await getPool().query(
          "select catalog_version from catalog_active_version",
        )
      ).rows[0].catalog_version,
    ).toBe(version);
    await getPool().query("delete from catalog_active_version");
  });
});
