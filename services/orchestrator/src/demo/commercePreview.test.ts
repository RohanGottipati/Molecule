import { describe, expect, it } from "vitest";
import {
  createDemoStoreConsole,
  demoRecipeGallery,
} from "./commercePreview.js";

describe("local demo commerce previews", () => {
  it("keeps store totals, orders, customers and analytics consistent", async () => {
    const console = createDemoStoreConsole();
    const list = await console.list();
    expect(list.mode).toBe("demo");
    expect(list.stores.length).toBeGreaterThan(4);
    for (const store of list.stores) {
      const catalog = (await console.catalog(store.shopDomain, 100))!;
      const orders = (await console.orders(store.shopDomain, 100))!;
      const customers = (await console.customers(store.shopDomain, 100))!;
      const analytics = (await console.analytics(store.shopDomain))!;
      expect(catalog.products.length).toBe(store.productCount);
      expect(orders.orders.length).toBe(store.orderCount);
      expect(customers.customers.length).toBe(store.customerCount);
      const gross = orders.orders.reduce((sum, o) => sum + Number(o.total), 0);
      expect(Number(analytics.totals.grossSales)).toBeCloseTo(gross);
      expect(
        customers.customers.reduce((sum, c) => sum + Number(c.amountSpent), 0),
      ).toBeCloseTo(gross);
      expect(
        analytics.daily.reduce((sum, d) => sum + Number(d.grossSales), 0),
      ).toBeCloseTo(gross);
      expect(
        analytics.topProducts.reduce((sum, p) => sum + Number(p.grossSales), 0),
      ).toBeCloseTo(gross);
      expect(orders.orders.every((o) => o.synthetic)).toBe(true);
      expect(analytics.provenance).toBe("synthetic_only");
      expect((await console.orders(store.shopDomain, 2))!.orders).toHaveLength(
        2,
      );
    }
    expect(await console.catalog("unknown.myshopify.com", 10)).toBeUndefined();
  });
  it("labels recipe inspiration as synthetic without inventing verification", async () => {
    const gallery = await demoRecipeGallery();
    expect(gallery.recipes).toHaveLength(6);
    expect(
      gallery.recipes.every((r) => r.synthetic && r.verifiedAt === null),
    ).toBe(true);
    expect(
      gallery.recipes.filter((r) => r.readiness === "ready_for_solver"),
    ).toHaveLength(1);
    expect(
      gallery.recipes.slice(1).every((r) => r.missingEvidence.length > 0),
    ).toBe(true);
  });
});
