import { describe, expect, it } from "vitest";

import { MockShopifyAdapter } from "./catalog/mock-adapter.js";
import {
  extractCapacityClaims,
  merchantIdForShopifyStore,
} from "./reality-extract.js";

describe("Shopify Reality extraction", () => {
  it("creates one capacity claim per tracked capacity item without network access", async () => {
    const adapter = new MockShopifyAdapter({ stores: ["stitchworks-test"] });
    const snapshot = await adapter.getSnapshot("stitchworks-test");

    expect(extractCapacityClaims(snapshot, "stitch-works")).toEqual([
      {
        merchantId: "stitch-works",
        field: "capacity_per_day",
        rawValue: 20,
        sourceKind: "shopify",
        sourceReference: snapshot.capacity[0]!.itemId,
        observedAt: "2026-09-19T12:00:00.000Z",
        sourceAuthority: 0.9,
        extractionConfidence: 1,
        evidenceText: `${snapshot.capacity[0]!.title} tracked inventory = 20`,
      },
    ]);
  });

  it("maps only stores backed by seeded Tiger merchants", () => {
    expect(merchantIdForShopifyStore("stitchworks-7gw6fagb")).toBe(
      "stitch-works",
    );
    expect(merchantIdForShopifyStore("printpress-b9oy1d5n")).toBeUndefined();
    expect(merchantIdForShopifyStore("molecule-storefront")).toBeUndefined();
  });
});
