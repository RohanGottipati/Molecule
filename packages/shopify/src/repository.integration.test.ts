import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockShopifyClient } from "./client.js";
import { eventFor, PostgresShopifyActionRepository } from "./repository.js";
import { plan } from "../tests/helpers.js";
import { ShopifyError } from "./types.js";

const databaseUrl = process.env.SHOPIFY_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL Shopify journal", () => {
  const namespace = `shopify-test-${randomUUID()}`;
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2000,
  });
  const secondPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2000,
  });
  const repository = new PostgresShopifyActionRepository(pool, namespace);
  const secondRepository = new PostgresShopifyActionRepository(
    secondPool,
    namespace,
  );
  beforeAll(async () => {
    await pool.query(
      await readFile(
        new URL("../../../sql/007_shopify.sql", import.meta.url),
        "utf8",
      ),
    );
  });
  afterAll(async () => {
    await pool.query(
      "DELETE FROM molecule_shopify_webhooks WHERE namespace=$1",
      [namespace],
    );
    await pool.query("DELETE FROM molecule_shopify_events WHERE namespace=$1", [
      namespace,
    ]);
    await pool.query("DELETE FROM molecule_shopify_orders WHERE namespace=$1", [
      namespace,
    ]);
    await pool.end();
    await secondPool.end();
  });

  it("serializes independent pools and survives reopening the adapter/repository", async () => {
    const clients = [
      new MockShopifyClient({ repository }),
      new MockShopifyClient({ repository: secondRepository }),
    ];
    const receipts = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        clients[index % 2]!.commit(plan(), `db-${index}`),
      ),
    );
    for (const receipt of receipts) expect(receipt).toEqual(receipts[0]);
    const fresh = new MockShopifyClient({
      repository: new PostgresShopifyActionRepository(secondPool, namespace),
    });
    expect(await fresh.commit(plan(), "db-restart")).toEqual(receipts[0]);
    expect(
      Object.keys((await repository.inspect(plan().orderId))!.mockResources),
    ).toHaveLength(4);
    const events = await repository.events(plan().orderId);
    expect(
      events.filter((event) => event.eventType === "shopify.action.succeeded"),
    ).toHaveLength(4);
    expect(
      events.filter((event) => event.eventType === "shopify.action.pending"),
    ).toHaveLength(4);
  });
  it("atomically deduplicates concurrent webhook receipts and rejects changed bodies", async () => {
    const event = eventFor("db-webhook", "shopify.webhook.inventory", {
      available: 0,
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        [repository, secondRepository][index % 2]!.recordWebhook(
          "x.myshopify.com",
          "delivery",
          "body-hash",
          event,
        ),
      ),
    );
    expect(results.filter((result) => result === "accepted")).toHaveLength(1);
    expect(
      (await repository.events()).filter(
        (entry) => entry.eventId === event.eventId,
      ),
    ).toHaveLength(1);
    await expect(
      repository.recordWebhook("x.myshopify.com", "delivery", "changed", event),
    ).rejects.toThrow("WEBHOOK_REPLAY_CONFLICT");
  });
  it("releases the order lock when a worker throws", async () => {
    await expect(
      repository.withOrder("failed-order", async () => {
        throw new Error("test");
      }),
    ).rejects.toThrow("test");
    expect(
      await secondRepository.withOrder("failed-order", async () => "released"),
    ).toBe("released");
  });

  it("preserves product/customer identity across multiple persisted replacement plans", async () => {
    const firstClient = new MockShopifyClient({ repository });
    const secondClient = new MockShopifyClient({
      repository: secondRepository,
    });
    const original = plan({ orderId: "db-replacement" });
    const first = await firstClient.commit(original, "db-first");
    const replacement = plan({
      orderId: original.orderId,
      planId: "replacement",
      intentVersion: 2,
      nodes: original.nodes.map((node) =>
        node.nodeId === "embroidery"
          ? { ...node, merchantId: "needle-north" }
          : node,
      ),
    });
    await secondClient.commit(replacement, "db-second");
    const revised = plan({
      ...replacement,
      planId: "revised",
      intentVersion: 3,
      totalCost: 3500,
      nodes: replacement.nodes.map((node) =>
        node.nodeId === "hoodie"
          ? { ...node, unitCost: 13, totalCost: 2600 }
          : node,
      ),
    });
    const result = await firstClient.commit(revised, "db-third");
    expect(result.compositeProduct?.productGid).toBe(
      first.compositeProduct?.productGid,
    );
    expect(result.customerOrder).toEqual(first.customerOrder);
    expect(await secondClient.commit(revised, "db-retry")).toEqual(result);
    expect(
      Object.keys((await repository.inspect(original.orderId))!.mockResources),
    ).toHaveLength(6);
  });

  it("cancels inherited jobs after reopening a failed replacement and prevents stale commits", async () => {
    const original = plan({ orderId: "db-inherited-cancellation" });
    const first = await new MockShopifyClient({ repository }).commit(
      original,
      "initial",
    );
    const replacement = { ...original, planId: "db-failed-replacement" };
    const failing = new MockShopifyClient({
      repository: secondRepository,
      beforeEffect: async (effect) => {
        if (effect.operation === "product")
          throw new ShopifyError("TEST_REJECTION");
      },
    });
    const failed = await failing.commit(replacement, "replace");
    expect(failed.actions.some((action) => action.status === "FAILED")).toBe(
      true,
    );
    const reopened = new MockShopifyClient({ repository });
    const cancelled = await reopened.supersede(
      original.orderId,
      replacement.planId,
      "cancel",
    );
    expect(cancelled.actions).toHaveLength(first.supplierJobs.length);
    expect(
      cancelled.actions.every((action) => action.status === "SUCCEEDED"),
    ).toBe(true);
    await expect(reopened.commit(replacement, "stale")).rejects.toThrow(
      "PLAN_SUPERSEDED",
    );
    const final = await new MockShopifyClient({
      repository: secondRepository,
    }).commit({ ...original, planId: "db-final-replacement" }, "final");
    expect(
      final.supplierJobs.every(
        (job) =>
          !first.supplierJobs.some(
            (previous) => previous.draftOrderGid === job.draftOrderGid,
          ),
      ),
    ).toBe(true);
  });
});
