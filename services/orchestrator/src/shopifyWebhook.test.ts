import { createHmac, randomUUID } from "node:crypto";

import { MockOpenAIAdapter } from "@molecule/openai";
import type { MoleculeEvent } from "@molecule/contracts";
import type { ShopifyActionRepository } from "@molecule/shopify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigSchema } from "./config.js";
import { LocalStore } from "./LocalStore.js";
import { MockMerchantAgentClient } from "./mocks/MockMerchantAgentClient.js";
import { MockRealityClient } from "./mocks/MockRealityClient.js";
import { MockShopifyClient } from "./mocks/MockShopifyClient.js";
import { buildServer } from "./server.js";
import { Orchestrator } from "./workflow/Orchestrator.js";

const secret = "webhook-test-secret";
const rawBody = Buffer.from(
  '{"inventory_item_id":123,"location_id":456,"available":0,"email":"discard@example.test"}',
);

function signature(body = rawBody) {
  return createHmac("sha256", secret).update(body).digest("base64");
}

async function fixture() {
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
  const events: MoleculeEvent[] = [];
  const repository = {
    recordWebhook: vi.fn(
      async (
        _domain: string,
        _deliveryId: string,
        _bodyHash: string,
        event: MoleculeEvent,
      ) => {
        events.push(event);
        return "accepted" as const;
      },
    ),
  } as unknown as ShopifyActionRepository;
  const ingestInventoryUpdate = vi.fn(async () => undefined);
  const app = await buildServer({
    ...dependencies,
    config: ConfigSchema.parse({ SHOPIFY_API_SECRET: secret }),
    orchestrator: new Orchestrator(dependencies),
    desktopStore: store,
    shopifyWebhook: {
      options: {
        secret,
        allowedDomains: ["basegoods-tyefhh8o.myshopify.com"],
        repository,
      },
      ingestInventoryUpdate,
    },
  });
  return { app, events, ingestInventoryUpdate };
}

describe("Shopify webhook route", () => {
  const apps: Awaited<ReturnType<typeof fixture>>["app"][] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("verifies raw JSON before parsing, persists the normalized event, and re-ingests inventory", async () => {
    const { app, events, ingestInventoryUpdate } = await fixture();
    apps.push(app);
    const deliveryId = randomUUID();
    const triggeredAt = "2026-09-19T12:01:00.000Z";

    const response = await app.inject({
      method: "POST",
      url: "/api/shopify/webhooks",
      payload: rawBody,
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": signature(),
        "x-shopify-webhook-id": deliveryId,
        "x-shopify-shop-domain": "basegoods-tyefhh8o.myshopify.com",
        "x-shopify-topic": "inventory_levels/update",
        "x-shopify-triggered-at": triggeredAt,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      inventory_item_id: 123,
      location_id: 456,
      available: 0,
    });
    expect(JSON.stringify(events)).not.toContain("discard@example.test");
    expect(ingestInventoryUpdate).toHaveBeenCalledWith({
      shop: "basegoods-tyefhh8o.myshopify.com",
      inventoryItemId: 123,
      locationId: 456,
      available: 0,
      observedAt: triggeredAt,
      traceId: `shopify-webhook:${deliveryId}`,
    });
  });

  it("returns Shopify-safe status codes without processing invalid deliveries", async () => {
    const { app, events, ingestInventoryUpdate } = await fixture();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/shopify/webhooks",
      payload: rawBody,
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": "invalid",
        "x-shopify-webhook-id": randomUUID(),
        "x-shopify-shop-domain": "basegoods-tyefhh8o.myshopify.com",
        "x-shopify-topic": "inventory_levels/update",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(events).toEqual([]);
    expect(ingestInventoryUpdate).not.toHaveBeenCalled();
  });
});
