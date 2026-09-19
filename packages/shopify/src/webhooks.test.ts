import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleShopifyWebhook, verifyWebhookHmac } from "./webhooks.js";
import { TestRepository } from "../tests/helpers.js";

const secret = "test-webhook-secret";
const rawBody = Buffer.from(
  '{"inventory_item_id":123,"location_id":456,"available":0,"email":"never-store@example.test"}',
);
const sign = (body = rawBody) =>
  createHmac("sha256", secret).update(body).digest("base64");
const headers = () => ({
  "x-shopify-hmac-sha256": sign(),
  "x-shopify-webhook-id": randomUUID(),
  "x-shopify-shop-domain": "base-goods.myshopify.com",
  "x-shopify-topic": "inventory_levels/update",
});

describe("Shopify webhooks", () => {
  it("verifies raw bytes with constant-time HMAC comparison", () => {
    expect(verifyWebhookHmac(rawBody, sign(), secret)).toBe(true);
    expect(verifyWebhookHmac(Buffer.from(`${rawBody} `), sign(), secret)).toBe(
      false,
    );
    for (const signature of ["", "bad", sign().slice(0, -1), `${sign()}=`]) {
      expect(verifyWebhookHmac(rawBody, signature, secret)).toBe(false);
    }
  });
  it("persists normalized allowlisted fields exactly once across concurrent replays", async () => {
    const repository = new TestRepository();
    const options = {
      secret,
      repository,
      allowedDomains: ["base-goods.myshopify.com"],
    };
    const input = { rawBody, headers: headers() };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => handleShopifyWebhook(options, input)),
    );
    expect(
      results.filter((result) => result.status === "accepted"),
    ).toHaveLength(1);
    expect(new Set(results.map((result) => result.eventId)).size).toBe(1);
    const events = await repository.events();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.available).toBe(0);
    expect(JSON.stringify(events)).not.toContain("never-store");
  });
  it("rejects unknown stores, bad HMAC, unsupported topics and replay conflicts", async () => {
    const repository = new TestRepository();
    const options = {
      secret,
      repository,
      allowedDomains: ["base-goods.myshopify.com"],
    };
    const valid = headers();
    await expect(
      handleShopifyWebhook(options, {
        rawBody,
        headers: { ...valid, "x-shopify-shop-domain": "unknown.myshopify.com" },
      }),
    ).rejects.toThrow("WEBHOOK_UNAUTHORIZED");
    await expect(
      handleShopifyWebhook(options, {
        rawBody,
        headers: { ...valid, "x-shopify-hmac-sha256": "bad" },
      }),
    ).rejects.toThrow("WEBHOOK_UNAUTHORIZED");
    await expect(
      handleShopifyWebhook(options, {
        rawBody,
        headers: { ...valid, "x-shopify-topic": "orders/paid" },
      }),
    ).rejects.toThrow("WEBHOOK_TOPIC_NOT_SUPPORTED");
    await handleShopifyWebhook(options, { rawBody, headers: valid });
    const other = Buffer.from('{"available":12}');
    await expect(
      handleShopifyWebhook(options, {
        rawBody: other,
        headers: { ...valid, "x-shopify-hmac-sha256": sign(other) },
      }),
    ).rejects.toThrow("WEBHOOK_REPLAY_CONFLICT");
  });
});
