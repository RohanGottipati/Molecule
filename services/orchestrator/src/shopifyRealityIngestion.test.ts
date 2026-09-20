import { describe, expect, it, vi } from "vitest";

import { ingestShopifyInventoryUpdate } from "./shopifyRealityIngestion.js";

describe("Shopify inventory re-ingestion", () => {
  it("delegates the exact item, location and observation time to Reality", async () => {
    const observe = vi.fn().mockResolvedValue({
      status: "changed",
      resourceId: "stock-123",
      merchantId: "base-goods",
    });
    const update = {
      shop: "basegoods-tyefhh8o.myshopify.com",
      inventoryItemId: 123,
      locationId: 456,
      available: 0,
      observedAt: "2026-09-20T12:00:00.000Z",
      traceId: "shopify-webhook:test",
    };

    await expect(
      ingestShopifyInventoryUpdate(update, observe),
    ).resolves.toEqual({
      status: "changed",
      resourceId: "stock-123",
      merchantId: "base-goods",
    });
    expect(observe).toHaveBeenCalledWith(update);
  });
});
