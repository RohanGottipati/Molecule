import { describe, expect, it } from "vitest";
import { DEMO_STORE_HANDLES } from "@molecule/test-fixtures";
import { FakeShopifyAdmin } from "./admin.js";
import { MockShopifyAdapter } from "../catalog/mock-adapter.js";
import { ShopifyTransport } from "../transport.js";
import { ShopifyError } from "../types.js";
import { fieldArguments, parseOperation } from "./graphql.js";

const AUTH = { accessToken: "shpat_fake_local" } as const;

function transportFor(admin: FakeShopifyAdmin, handle: string) {
  return new ShopifyTransport({
    domain: `${handle}.myshopify.com`,
    auth: AUTH,
    fetch: admin.fetch,
  });
}

describe("fake Shopify Admin request parsing", () => {
  it("reads every root field of a multi-root anonymous query", () => {
    // scripts/shopify-sync.mjs asks for `shop` and `products` in one anonymous operation.
    const parsed = parseOperation(`query($c:String){
      shop{ name currencyCode }
      products(first:15, after:$c){ pageInfo{ hasNextPage endCursor } edges{ node{ id } } } }`);
    expect(parsed.operationName).toBe("");
    expect(parsed.isMutation).toBe(false);
    expect(parsed.rootFields).toEqual(["shop", "products"]);
  });

  it("reads the root field of an anonymous mutation", () => {
    // scripts/shopify-writeback.mjs shape.
    const parsed = parseOperation(
      `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){metafields{id} userErrors{field message code}}}`,
    );
    expect(parsed.isMutation).toBe(true);
    expect(parsed.rootFields).toEqual(["metafieldsSet"]);
  });

  it("reads a named operation", () => {
    const parsed = parseOperation(
      `query Products($after: String) { products(first: 100, after: $after) { nodes { id } } }`,
    );
    expect(parsed.operationName).toBe("Products");
    expect(parsed.rootFields).toEqual(["products"]);
  });

  it("resolves literal and variable arguments, including quoted search terms", () => {
    const query = `{products(first:20,query:"tag:capacity"){edges{node{id}}}}`;
    expect(fieldArguments(query, "products", {})).toEqual({
      first: 20,
      query: "tag:capacity",
    });
    expect(
      fieldArguments(
        `query P($after:String){products(first:15,after:$after){nodes{id}}}`,
        "products",
        {
          after: "abc",
        },
      ),
    ).toEqual({ first: 15, after: "abc" });
  });
});

describe("fake Shopify Admin matches the catalog mock", () => {
  it.each(DEMO_STORE_HANDLES)(
    "serves %s identically to MockShopifyAdapter",
    async (handle) => {
      const admin = new FakeShopifyAdmin({ catalogProfile: "release" });
      const mock = new MockShopifyAdapter({ catalogProfile: "release" });

      const viaTransport = await transportFor(admin, handle).getSnapshot(
        `${handle}.myshopify.com`,
      );
      const viaMock = await mock.getSnapshot(handle);

      // Identity is per-adapter, so compare the catalog facts rather than the GIDs.
      const shape = (snapshot: typeof viaMock) =>
        snapshot.products
          .map((product) => ({
            handle: product.handle,
            title: product.title,
            vendor: product.vendor,
            productType: product.productType,
            tags: [...product.tags].sort(),
            variants: product.variants.map((variant) => ({
              sku: variant.sku,
              price: variant.price,
              tracked: variant.tracked,
              optionValues: variant.optionValues,
            })),
          }))
          .sort((a, b) => a.handle.localeCompare(b.handle));

      expect(shape(viaTransport)).toEqual(shape(viaMock));
    },
  );

  it("reports the same tracked capacity quantities as the mock", async () => {
    const admin = new FakeShopifyAdmin({ catalogProfile: "release" });
    const mock = new MockShopifyAdapter({ catalogProfile: "release" });
    const handle = "threadforge-eznglsyk";

    const viaTransport = await transportFor(admin, handle).getSnapshot(
      `${handle}.myshopify.com`,
    );
    const viaMock = await mock.getSnapshot(handle);

    const capacity = (items: { title: string; quantity: number | null }[]) =>
      items
        .map(({ title, quantity }) => ({ title, quantity }))
        .sort((a, b) => a.title.localeCompare(b.title));

    expect(capacity(viaTransport.capacity)).toEqual(capacity(viaMock.capacity));
    expect(viaTransport.capacity.length).toBeGreaterThan(0);
  });
});

describe("fake Shopify Admin transport behavior", () => {
  it("paginates products so the transport must follow cursors", async () => {
    const admin = new FakeShopifyAdmin();
    const transport = transportFor(admin, "stitchworks-7gw6fagb");
    const snapshot = await transport.getSnapshot(
      "stitchworks-7gw6fagb.myshopify.com",
    );
    // The seeded catalog exceeds one page of 100, or at minimum returns every product.
    expect(snapshot.products.length).toBe(
      admin.store("stitchworks-7gw6fagb.myshopify.com").products.size,
    );
  });

  it("exchanges client credentials for a token", async () => {
    const admin = new FakeShopifyAdmin();
    const transport = new ShopifyTransport({
      domain: "basegoods-tyefhh8o.myshopify.com",
      auth: { clientId: "fake-client", clientSecret: "fake-secret" },
      fetch: admin.fetch,
    });
    const verified = await transport.verifyStore();
    expect(verified.shop.currencyCode).toBe("CAD");
    expect(verified.shop.myshopifyDomain).toBe(
      "basegoods-tyefhh8o.myshopify.com",
    );
  });

  it("retries through a THROTTLED response", async () => {
    const admin = new FakeShopifyAdmin({ throttleEvery: 2 });
    const transport = transportFor(admin, "basegoods-tyefhh8o");
    // First call succeeds, second is throttled, the transport retries and succeeds.
    await expect(transport.verifyStore()).resolves.toBeDefined();
    await expect(transport.verifyStore()).resolves.toBeDefined();
  });

  it("rejects an unknown shop rather than inventing one", async () => {
    const admin = new FakeShopifyAdmin();
    const transport = new ShopifyTransport({
      domain: "not-a-seeded-store.myshopify.com",
      auth: AUTH,
      fetch: admin.fetch,
    });
    await expect(transport.verifyStore()).rejects.toThrow(ShopifyError);
  });

  it("surfaces an unhandled root field as a GraphQL error", async () => {
    const admin = new FakeShopifyAdmin();
    const transport = transportFor(admin, "basegoods-tyefhh8o");
    await expect(
      transport.graphql(
        "query Nope { giftCards { id } }",
        {},
        (await import("zod")).z.unknown(),
      ),
    ).rejects.toThrow(ShopifyError);
  });
});

describe("fake Shopify Admin inventory writes", () => {
  it("applies inventorySetQuantities and replays an idempotent key", async () => {
    const admin = new FakeShopifyAdmin();
    const domain = "threadforge-eznglsyk.myshopify.com";
    const transport = transportFor(admin, "threadforge-eznglsyk");
    const snapshot = await transport.getSnapshot(domain);
    const item = snapshot.capacity[0]!;
    expect(item.quantity).not.toBe(0);

    const { z } = await import("zod");
    const mutation = `mutation($i:InventorySetQuantitiesInput!,$k:String!){inventorySetQuantities(input:$i) @idempotent(key:$k){userErrors{field message code}}}`;
    const variables = {
      k: "molecule-test-key",
      i: {
        name: "available",
        reason: "correction",
        quantities: [
          {
            inventoryItemId: item.itemId,
            locationId: admin.store(domain).locations[0]!.id,
            quantity: 0,
          },
        ],
      },
    };
    const schema = z.object({
      inventorySetQuantities: z.object({ userErrors: z.array(z.unknown()) }),
    });

    const first = await transport.graphql(mutation, variables, schema, true);
    expect(first.inventorySetQuantities.userErrors).toEqual([]);

    const after = await transport.getSnapshot(domain);
    expect(after.capacity.find((c) => c.itemId === item.itemId)?.quantity).toBe(
      0,
    );

    // Replaying the same key must not be treated as a conflict.
    const replay = await transport.graphql(mutation, variables, schema, true);
    expect(replay.inventorySetQuantities.userErrors).toEqual([]);
  });

  it("reports a conflict when an idempotency key is reused with different input", async () => {
    const admin = new FakeShopifyAdmin();
    const domain = "threadforge-eznglsyk.myshopify.com";
    const transport = transportFor(admin, "threadforge-eznglsyk");
    const item = (await transport.getSnapshot(domain)).capacity[0]!;
    const locationId = admin.store(domain).locations[0]!.id;
    const { z } = await import("zod");
    const schema = z.object({
      inventorySetQuantities: z.object({
        userErrors: z.array(z.object({ code: z.string() })),
      }),
    });
    const mutation = `mutation($i:InventorySetQuantitiesInput!,$k:String!){inventorySetQuantities(input:$i) @idempotent(key:$k){userErrors{field message code}}}`;
    const build = (quantity: number) => ({
      k: "molecule-conflict-key",
      i: {
        name: "available",
        reason: "correction",
        quantities: [{ inventoryItemId: item.itemId, locationId, quantity }],
      },
    });

    await transport.graphql(mutation, build(5), schema, true);
    const conflict = await transport.graphql(mutation, build(9), schema, true);
    expect(conflict.inventorySetQuantities.userErrors[0]?.code).toBe(
      "CONFLICT",
    );
  });

  it("resets back to the deterministic seed", async () => {
    const admin = new FakeShopifyAdmin();
    const domain = "threadforge-eznglsyk.myshopify.com";
    const transport = transportFor(admin, "threadforge-eznglsyk");
    const before = (await transport.getSnapshot(domain)).capacity[0]!;
    admin.setInventory(domain, before.itemId, 0);
    expect(
      (await transport.getSnapshot(domain)).capacity.find(
        (c) => c.itemId === before.itemId,
      )?.quantity,
    ).toBe(0);

    admin.reset();
    const after = (await transport.getSnapshot(domain)).capacity.find(
      (c) => c.title === before.title,
    );
    expect(after?.quantity).toBe(before.quantity);
  });
});

describe("fake Shopify Admin synthetic commerce", () => {
  it("generates orders and customers that reconcile with each other", async () => {
    const admin = new FakeShopifyAdmin();
    const store = admin.store("basegoods-tyefhh8o.myshopify.com");
    expect(store.orders.size).toBeGreaterThan(0);
    expect(store.customers.size).toBeGreaterThan(0);

    const spendByCustomer = new Map<string, number>();
    for (const order of store.orders.values()) {
      // Every line item references a variant the store actually sells.
      for (const line of order.lineItems) {
        const owns = [...store.products.values()].some((product) =>
          product.variants.some((variant) => variant.id === line.variantId),
        );
        expect(owns).toBe(true);
      }
      spendByCustomer.set(
        order.customerId,
        (spendByCustomer.get(order.customerId) ?? 0) +
          Number(order.totalAmount),
      );
    }

    for (const [customerId, spend] of spendByCustomer) {
      const customer = store.customers.get(customerId)!;
      expect(Number(customer.amountSpent)).toBeCloseTo(spend, 1);
    }
  });

  it("labels every synthetic record and never uses a routable email domain", () => {
    const admin = new FakeShopifyAdmin();
    for (const domain of admin.listStores()) {
      const store = admin.store(domain);
      for (const customer of store.customers.values()) {
        expect(customer.tags).toContain("synthetic");
        expect(customer.email.endsWith("@synthetic.invalid")).toBe(true);
      }
      for (const order of store.orders.values()) {
        expect(order.tags).toContain("MOLECULE_DEMO");
      }
    }
  });

  it("is deterministic across instances", () => {
    const a = new FakeShopifyAdmin();
    const b = new FakeShopifyAdmin();
    const summarize = (admin: FakeShopifyAdmin) =>
      admin.listStores().map((domain) => {
        const store = admin.store(domain);
        return [
          domain,
          store.products.size,
          store.orders.size,
          store.customers.size,
          [...store.orders.values()].map((o) => o.totalAmount).join(","),
        ].join("|");
      });
    expect(summarize(a)).toEqual(summarize(b));
  });
});

describe("fake Shopify Admin overlay persistence", () => {
  it("carries an inventory edit across processes without re-seeding the catalog", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { PersistentFakeShopifyAdmin } = await import("./persistence.js");

    const dataDir = mkdtempSync(join(tmpdir(), "molecule-fake-"));
    try {
      const domain = "threadforge-eznglsyk.myshopify.com";

      // Process 1: read the seeded value, then edit it (what shopify-set-capacity.mjs does).
      const first = new PersistentFakeShopifyAdmin({ dataDir });
      const before = (
        await transportFor(first, "threadforge-eznglsyk").getSnapshot(domain)
      ).capacity[0]!;
      expect(before.quantity).not.toBe(0);
      first.setInventory(domain, before.itemId, 0);

      // Process 2: a brand-new instance must still observe the edit.
      const second = new PersistentFakeShopifyAdmin({ dataDir });
      const after = (
        await transportFor(second, "threadforge-eznglsyk").getSnapshot(domain)
      ).capacity.find((item) => item.title === before.title);
      expect(after?.quantity).toBe(0);

      // The catalog itself is still regenerated from the fixtures, not persisted.
      expect(second.store(domain).products.size).toBe(
        first.store(domain).products.size,
      );

      // Reset clears the overlay for the next process too.
      second.reset();
      const third = new PersistentFakeShopifyAdmin({ dataDir });
      const restored = (
        await transportFor(third, "threadforge-eznglsyk").getSnapshot(domain)
      ).capacity.find((item) => item.title === before.title);
      expect(restored?.quantity).toBe(before.quantity);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
