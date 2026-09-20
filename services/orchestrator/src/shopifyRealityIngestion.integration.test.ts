import { createHmac, randomUUID } from "node:crypto";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  closePool,
  listMerchantClaims,
  migrate,
  resetDemoData,
  seedDemo,
  transaction,
} from "@molecule/db";
import { MockOpenAIAdapter } from "@molecule/openai";
import { resolveMerchant } from "@molecule/service-reality";
import { PostgresShopifyActionRepository } from "@molecule/shopify";
import { MockShopifyAdapter } from "@molecule/shopify/catalog";
import { getPool } from "@molecule/db";

import { ConfigSchema } from "./config.js";
import { LocalStore } from "./LocalStore.js";
import { MockMerchantAgentClient } from "./mocks/MockMerchantAgentClient.js";
import { MockRealityClient } from "./mocks/MockRealityClient.js";
import { MockShopifyClient } from "./mocks/MockShopifyClient.js";
import { buildServer } from "./server.js";
import {
  ingestShopifyCapacityBatch,
  ingestShopifyInventoryUpdate,
} from "./shopifyRealityIngestion.js";
import { Orchestrator } from "./workflow/Orchestrator.js";

const database = process.env.TEST_DATABASE_URL;

describe.skipIf(!database)("Shopify capacity ingestion", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    process.env.DEMO_MODE = "true";
    await migrate();
    await seedDemo();
  });

  beforeEach(async () => {
    await resetDemoData();
  });

  afterAll(closePool);

  it("ingests known capacity idempotently and skips an unmapped Shopify store", async () => {
    const source = new MockShopifyAdapter({
      stores: ["stitchworks-test", "printpress-test"],
    });
    const stores = source.listStores();

    const first = await ingestShopifyCapacityBatch(source, stores, {
      traceId: "shopify-batch-first",
    });
    const second = await ingestShopifyCapacityBatch(source, stores, {
      traceId: "shopify-batch-second",
    });

    expect(first).toMatchObject({
      accepted: 1,
      quarantined: 0,
      skippedStores: ["printpress-test"],
    });
    expect(second.claimIds).toEqual(first.claimIds);
  });

  it("persists an authenticated inventory webhook and resolves its Shopify capacity claim", async () => {
    const secret = "shopify-webhook-integration-secret";
    const domain = "stitchworks-webhook-test.myshopify.com";
    const repository = new PostgresShopifyActionRepository(
      getPool(),
      `shopify-webhook-${randomUUID()}`,
    );
    const source = new MockShopifyAdapter({ stores: ["stitchworks-webhook-test"] });
    const snapshot = await source.getSnapshot("stitchworks-webhook-test");
    const capacity = snapshot.capacity[0];
    if (!capacity) throw new Error("StitchWorks mock must expose capacity");
    const initial = await ingestShopifyCapacityBatch(
      source,
      source.listStores(),
      {
        traceId: "shopify-webhook-initial-capacity",
      },
    );
    expect(initial.accepted).toBe(1);
    // Isolate ordering within one Shopify observation stream. The seeded StitchWorks
    // notes deliberately conflict; independent-source conflict behavior is tested in Reality.
    await getPool().query("delete from canonical_claims where merchant_id='stitch-works' and field='capacity_per_day' and source_kind<>'shopify'");
    const store = new LocalStore();
    await store.load();
    const openai = new MockOpenAIAdapter();
    const solver = { solve: vi.fn() };
    const dependencies = {
      sessions: store,
      events: store,
      openai,
      solver,
      reality: new MockRealityClient(),
      merchantAgents: new MockMerchantAgentClient(),
      shopify: new MockShopifyClient(),
    };
    const app = await buildServer({
      ...dependencies,
      config: ConfigSchema.parse({ SHOPIFY_API_SECRET: secret }),
      orchestrator: new Orchestrator(dependencies),
      desktopStore: store,
      shopifyWebhook: {
        options: { secret, allowedDomains: [domain], repository },
        ingestInventoryUpdate: async (update) => {
          await ingestShopifyInventoryUpdate(update);
        },
      },
    });
    const triggeredAt = new Date(Date.now() + 1_000).toISOString();
    const body = Buffer.from(
      JSON.stringify({
        inventory_item_id: capacity.itemId,
        location_id: 24,
        available: 0,
      }),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/shopify/webhooks",
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-shopify-hmac-sha256": createHmac("sha256", secret)
            .update(body)
            .digest("base64"),
          "x-shopify-webhook-id": randomUUID(),
          "x-shopify-shop-domain": domain,
          "x-shopify-topic": "inventory_levels/update",
          "x-shopify-triggered-at": triggeredAt,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(await repository.events()).toHaveLength(1);
      const facts = await transaction((client) =>
        resolveMerchant("stitch-works", "shopify-webhook-assertion", client),
      );
      expect(
        facts.find((fact) => fact.field === "capacity_per_day"),
      ).toMatchObject({ status: "resolved", value: 0 });
      const claims = await transaction((client) =>
        listMerchantClaims("stitch-works", client),
      );
      expect(
        claims.find(
          (claim) =>
            claim.field === "capacity_per_day" && claim.normalizedValue === 0,
        ),
      ).toMatchObject({
        source: {
          kind: "shopify",
          reference: capacity.itemId,
        },
      });
      expect(
        claims.find((claim) => claim.claimId === initial.claimIds[0])
          ?.resolutionStatus,
      ).toBe("superseded");
    } finally {
      await app.close();
    }
  });
});
