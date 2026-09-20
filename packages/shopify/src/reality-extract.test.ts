import { describe, expect, it } from "vitest";

import { merchantIdForShopifyStore } from "./reality-extract.js";

describe("Shopify Reality extraction", () => {
  it("maps only stores backed by seeded Tiger merchants", () => {
    expect(merchantIdForShopifyStore("stitchworks-7gw6fagb")).toBe(
      "stitch-works",
    );
    expect(
      merchantIdForShopifyStore("stitchworks-7gw6fagb.myshopify.com"),
    ).toBe("stitch-works");
    expect(merchantIdForShopifyStore("printpress-b9oy1d5n")).toBeUndefined();
    expect(merchantIdForShopifyStore("molecule-storefront")).toBeUndefined();
  });
});
