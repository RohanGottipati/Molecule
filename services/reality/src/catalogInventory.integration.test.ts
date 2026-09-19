import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activateCatalog,
  closePool,
  getPool,
  importCatalog,
  migrate,
} from "@molecule/db";
import { observeCatalogInventory } from "./catalogInventory.js";

const database = process.env.TEST_DATABASE_URL;
const id = `scoped-${randomUUID()}`;
const shop = `${id}.myshopify.com`;
const oldTime = new Date(Date.now() - 120_000).toISOString();
const newTime = new Date(Date.now() - 60_000).toISOString();
const evidence = {
  observedAt: oldTime,
  sourceReference: "synthetic:inventory",
  synthetic: true,
};
describe.skipIf(!database)(
  "exact-location catalog inventory and recovery dispatch",
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = database;
      await migrate();
      const records = [
        {
          recordType: "merchant",
          id,
          name: "Scoped merchant",
          shopDomain: shop,
          evidence,
        },
        ...[1, 2].map((n) => ({
          recordType: "resource",
          id: `${id}:${n}`,
          merchantId: id,
          kind: "inventory",
          unit: "units",
          availability: { status: "known", value: 50 },
          inventoryItemGid: `gid://shopify/InventoryItem/${n}`,
          locationGid: "gid://shopify/Location/10",
          evidence,
        })),
      ];
      await importCatalog(
        [
          {
            recordType: "manifest",
            schemaVersion: 1,
            catalogVersion: id,
            complete: true,
            createdAt: oldTime,
            categories: ["Apparel"],
            recordCounts: {
              merchant: 1,
              resource: 2,
              product: 0,
              variant: 0,
              binding: 0,
              fact: 0,
              family: 0,
              recipe: 0,
            },
          },
          ...records,
        ]
          .map((r) => JSON.stringify(r))
          .join("\n"),
        id,
      );
      await activateCatalog(id, id, `activate:${id}`);
      for (const n of [1, 2])
        await getPool().query(
          "insert into order_sessions(order_id,revision,session_json) values($1,0,$2)",
          [
            `${id}:order:${n}`,
            {
              state: "COMPLETED",
              activePlan: {
                nodes: [{ resourceRefs: [{ resourceId: `${id}:${n}` }] }],
              },
            },
          ],
        );
    });
    afterAll(async () => {
      await getPool().query(
        "delete from catalog_active_version where catalog_version=$1",
        [id],
      );
      await closePool();
    });
    it("updates only mapped stock, handles duplicates and old observations, and queues only affected orders", async () => {
      const observation = {
        shop,
        inventoryItemId: 1,
        locationId: 10,
        available: 0,
        observedAt: newTime,
        traceId: id,
      };
      expect((await observeCatalogInventory(observation)).status).toBe(
        "changed",
      );
      expect((await observeCatalogInventory(observation)).status).toBe(
        "unchanged",
      );
      expect(
        (
          await observeCatalogInventory({
            ...observation,
            available: 100,
            observedAt: oldTime,
          })
        ).status,
      ).toBe("stale");
      expect(
        (await observeCatalogInventory({ ...observation, locationId: 11 }))
          .status,
      ).toBe("unmapped");
      const rows = (
        await getPool().query(
          "select available,synthetic from catalog_resource_state where merchant_id=$1 order by resource_id",
          [id],
        )
      ).rows;
      expect(rows.map((r) => Number(r.available))).toEqual([0, 50]);
      expect(rows.every((r) => r.synthetic)).toBe(true);
      expect(
        (
          await getPool().query(
            "select order_id from catalog_recovery_requests where resource_id=$1",
            [`${id}:1`],
          )
        ).rows,
      ).toEqual([{ order_id: `${id}:order:1` }]);
      expect(
        (
          await getPool().query(
            "select count(*) from canonical_claims where merchant_id=$1 and field='capacity_per_day'",
            [id],
          )
        ).rows[0].count,
      ).toBe("0");
      expect(
        (
          await observeCatalogInventory({
            ...observation,
            available: 80,
            observedAt: new Date(Date.now() - 30_000).toISOString(),
          })
        ).status,
      ).toBe("changed");
      expect(
        Number(
          (
            await getPool().query(
              "select available from catalog_resource_state where resource_id=$1",
              [`${id}:1`],
            )
          ).rows[0].available,
        ),
      ).toBe(80);
    });
    it("conflicts equal-time contradictory observations instead of selecting whichever arrived last", async () => {
      const observation = {
        shop,
        inventoryItemId: 2,
        locationId: 10,
        available: 20,
        observedAt: newTime,
        traceId: id,
      };
      await observeCatalogInventory(observation);
      await observeCatalogInventory({ ...observation, available: 10 });
      expect(
        (
          await getPool().query(
            "select status from catalog_resource_state where resource_id=$1",
            [`${id}:2`],
          )
        ).rows[0].status,
      ).toBe("conflicted");
    });
  },
);
