import { describe, expect, it, vi } from "vitest";

import {
  extractInventoryCapacityClaim,
  ingestShopifyInventoryUpdate,
} from "./shopifyRealityIngestion.js";

describe("Shopify inventory re-ingestion", () => {
  it("preserves the exact inventory item and location without inventing catalog facts", () => {
    expect(
      extractInventoryCapacityClaim(
        {
          shop: "basegoods-tyefhh8o.myshopify.com",
          inventoryItemId: 123,
          locationId: 456,
          available: 0,
        },
        "base-goods",
      ),
    ).toEqual({
      merchantId: "base-goods",
      field: "capacity_per_day",
      rawValue: 0,
      sourceKind: "shopify",
      sourceReference: "gid://shopify/InventoryItem/123",
      sourceAuthority: 0.9,
      extractionConfidence: 1,
      evidenceText: "Inventory item 123 at location 456 tracked inventory = 0",
    });
  });

  it("skips a Shopify store with no Tiger merchant before attempting ingestion", async () => {
    const ingest = vi.fn();

    await expect(
      ingestShopifyInventoryUpdate(
        {
          shop: "printpress-b9oy1d5n.myshopify.com",
          inventoryItemId: 123,
          available: 0,
          traceId: "shopify-webhook:test",
        },
        { ingest },
      ),
    ).resolves.toEqual({
      status: "skipped",
      shop: "printpress-b9oy1d5n.myshopify.com",
    });
    expect(ingest).not.toHaveBeenCalled();
  });
});
