import { describe, expect, it } from "vitest";
import { MockShopifyAdapter } from "./mock-adapter.js";
import type { CompositeProductPlan, SupplierJobPlanNode } from "./types.js";

const STORES = ["stitchworks-test", "molecule-test"] as const;

describe("MockShopifyAdapter", () => {
  it("opts into the release catalog without changing the broad catalog or reset profile", async () => {
    const stores = ["threadforge-test"];
    const broad = new MockShopifyAdapter({ stores });
    const release = new MockShopifyAdapter({
      stores,
      catalogProfile: "release",
    });
    expect((await broad.getSnapshot(stores[0]!)).capacity[0]?.quantity).toBe(
      400,
    );
    const before = await release.getSnapshot(stores[0]!);
    expect(before.capacity[0]?.quantity).toBe(400);
    expect(
      before.products.some((product) => product.tags.includes("release-demo")),
    ).toBe(true);
    await release.demoAdjustInventory(
      stores[0]!,
      before.capacity[0]!.itemId,
      0,
    );
    await release.reset();
    expect(await release.getSnapshot(stores[0]!)).toEqual(before);
    expect((await broad.getSnapshot(stores[0]!)).capacity[0]?.quantity).toBe(
      400,
    );
  });

  it("refuses to put a composite product in a supplier store when the central store is missing", async () => {
    const adapter = new MockShopifyAdapter({ stores: ["stitchworks-test"] });
    const before = await adapter.getSnapshot("stitchworks-test");
    await expect(
      adapter.upsertCompositeProduct({
        actionKey: "product",
        traceId: "trace",
        orderId: "order",
        planId: "plan",
        intentVersion: 1,
        title: "Kit",
        variants: [
          { optionValues: { Title: "Kit" }, price: "10.00", sku: "KIT" },
        ],
        riskScore: 0,
        provenance: "Synthetic",
      }),
    ).rejects.toThrow("CENTRAL_STORE_NOT_CONFIGURED");
    expect(await adapter.getSnapshot("stitchworks-test")).toEqual(before);
  });

  it("rejects invalid monetary amounts and fractional draft quantities without reserving action keys", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const node: SupplierJobPlanNode = {
      actionKey: "supplier",
      traceId: "trace",
      shop: "stitchworks-test",
      planId: "plan",
      nodeId: "node",
      lineItems: [{ title: "Embroidery", quantity: 1, price: "4.50" }],
    };
    for (const price of ["NaN", "Infinity", "-1.00", "1.001", " "]) {
      await expect(
        adapter.createSupplierJob({
          ...node,
          lineItems: [{ title: "Embroidery", quantity: 1, price }],
        }),
      ).rejects.toThrow();
      await expect(
        adapter.createCustomerCheckout({
          actionKey: "checkout",
          traceId: "trace",
          shop: "molecule-test",
          orderId: "order",
          planId: "plan",
          lineItemTitle: "Kit",
          price,
          currency: "CAD",
        }),
      ).rejects.toThrow();
      await expect(
        adapter.upsertCompositeProduct({
          actionKey: "product",
          traceId: "trace",
          orderId: "order",
          planId: "plan",
          intentVersion: 1,
          title: "Kit",
          variants: [{ optionValues: { Title: "Kit" }, price, sku: "KIT" }],
          riskScore: 0,
          provenance: "Synthetic",
        }),
      ).rejects.toThrow();
    }
    await expect(
      adapter.createSupplierJob({
        ...node,
        lineItems: [{ title: "Embroidery", quantity: 0.5, price: "4.50" }],
      }),
    ).rejects.toThrow();
    await expect(adapter.createSupplierJob(node)).resolves.toMatchObject({
      created: true,
    });
    await expect(
      adapter.createCustomerCheckout({
        actionKey: "checkout",
        traceId: "trace",
        shop: "molecule-test",
        orderId: "order",
        planId: "plan",
        lineItemTitle: "Kit",
        price: "4.50",
        currency: "CAD",
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it("works with no network and no env, loading the seed catalog deterministically", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const snapshot = await adapter.getSnapshot("stitchworks-test");
    expect(snapshot.role).toBe("stitchworks");
    expect(snapshot.products.length).toBeGreaterThan(0);
    expect(snapshot.capacity).toHaveLength(1);
    expect(snapshot.capacity[0]?.quantity).toBe(20);
  });

  it("upsertCompositeProduct: retrying the same actionKey yields one product, not two", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const plan: CompositeProductPlan = {
      actionKey: "action-1",
      traceId: "trace-1",
      orderId: "order-1",
      planId: "plan-1",
      intentVersion: 1,
      title: "Composite Kit",
      variants: [
        {
          optionValues: { Title: "Default Title" },
          price: "10.00",
          sku: "MOL-1",
        },
      ],
      riskScore: 0.2,
      provenance: "BaseGoods hoodie + StitchWorks embroidery",
    };

    const first = await adapter.upsertCompositeProduct(plan);
    const second = await adapter.upsertCompositeProduct(plan);
    expect(second).toEqual(first);

    const results = await adapter.searchCatalog({
      shop: "molecule-test",
      tag: "MOLECULE_PLAN",
    });
    expect(results).toHaveLength(1);
  });

  it("createSupplierJob: retrying the same actionKey yields one draft, not two", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const node: SupplierJobPlanNode = {
      actionKey: "job-action-1",
      traceId: "trace-1",
      shop: "stitchworks-test",
      planId: "plan-1",
      nodeId: "node-1",
      lineItems: [{ title: "Embroidery", quantity: 50, price: "4.50" }],
    };

    const first = await adapter.createSupplierJob(node);
    const second = await adapter.createSupplierJob(node);
    expect(second.jobId).toBe(first.jobId);
    expect(second).toEqual(first);
  });

  it("demoAdjustInventory changes what getSnapshot reports", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const before = await adapter.getSnapshot("stitchworks-test");
    const item = before.capacity[0]!;
    expect(item.quantity).toBe(20);

    await adapter.demoAdjustInventory("stitchworks-test", item.itemId, 0);

    const after = await adapter.getSnapshot("stitchworks-test");
    expect(after.capacity[0]?.quantity).toBe(0);
  });

  it("uses stable inventory-item identities without changing product variant identities", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const before = await adapter.getSnapshot("stitchworks-test");
    const capacity = before.capacity[0]!;
    expect(capacity.itemId).toMatch(/^gid:\/\/shopify\/InventoryItem\/\d+$/);
    const variants = before.products.flatMap((product) => product.variants);
    expect(
      variants.some((variant) => variant.variantId === capacity.itemId),
    ).toBe(false);

    await adapter.demoAdjustInventory("stitchworks-test", capacity.itemId, 0);
    const after = await adapter.getSnapshot("stitchworks-test");
    expect(after.capacity[0]).toMatchObject({
      itemId: capacity.itemId,
      quantity: 0,
    });
    expect(
      after.products.flatMap((product) =>
        product.variants.map((variant) => variant.variantId),
      ),
    ).toEqual(variants.map((variant) => variant.variantId));
    await adapter.reset();
    expect(
      (await adapter.getSnapshot("stitchworks-test")).capacity[0]?.itemId,
    ).toBe(capacity.itemId);
  });

  it("supersedeJob tags the job instead of deleting it, and is idempotent by actionKey", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const node: SupplierJobPlanNode = {
      actionKey: "job-action-2",
      traceId: "trace-1",
      shop: "stitchworks-test",
      planId: "plan-1",
      nodeId: "node-2",
      lineItems: [{ title: "Embroidery", quantity: 50, price: "4.50" }],
    };
    const job = await adapter.createSupplierJob(node);
    const reason = {
      actionKey: "supersede-1",
      traceId: "trace-2",
      reason: "capacity dropped to 0",
    };

    const first = await adapter.supersedeJob(job.jobId, reason);
    const second = await adapter.supersedeJob(job.jobId, reason);

    expect(first.tags).toContain("MOLECULE_JOB");
    expect(first.tags).toContain("MOLECULE_SUPERSEDED");
    expect(second).toEqual(first);
  });

  it("createCustomerCheckout returns an invoiceUrl-shaped result", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const result = await adapter.createCustomerCheckout({
      actionKey: "checkout-1",
      traceId: "trace-1",
      shop: "molecule-test",
      orderId: "order-1",
      planId: "plan-1",
      lineItemTitle: "Molecule composite order",
      price: "120.00",
      currency: "USD",
    });
    expect(new URL(result.invoiceUrl).hostname).toBe("shopify-mock.invalid");
  });

  it("reset restores seed state", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const before = await adapter.getSnapshot("stitchworks-test");
    await adapter.demoAdjustInventory(
      "stitchworks-test",
      before.capacity[0]!.itemId,
      0,
    );

    await adapter.reset();

    const after = await adapter.getSnapshot("stitchworks-test");
    expect(after.capacity[0]?.quantity).toBe(20);
    expect(after).toEqual(before);
  });

  it("rejects changed payloads and cross-operation reuse of an action key", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const node: SupplierJobPlanNode = {
      actionKey: "shared-key",
      traceId: "trace",
      shop: "stitchworks-test",
      planId: "plan",
      nodeId: "node",
      lineItems: [{ title: "Embroidery", quantity: 50, price: "4.50" }],
    };
    const first = await adapter.createSupplierJob(node);
    await expect(
      adapter.createSupplierJob({ ...node, nodeId: "different" }),
    ).rejects.toThrow("ACTION_KEY_CONFLICT");
    await expect(
      adapter.createCustomerCheckout({
        actionKey: node.actionKey,
        traceId: "trace",
        shop: "molecule-test",
        orderId: "order",
        planId: "plan",
        lineItemTitle: "Kit",
        price: "10",
        currency: "CAD",
      }),
    ).rejects.toThrow("ACTION_KEY_CONFLICT");
    expect(await adapter.createSupplierJob(node)).toEqual(first);
  });

  it("does not expose internal or cached job state through returned objects", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const node: SupplierJobPlanNode = {
      actionKey: "job",
      traceId: "trace",
      shop: "stitchworks-test",
      planId: "plan",
      nodeId: "node",
      lineItems: [{ title: "Embroidery", quantity: 50, price: "4.50" }],
    };
    const first = await adapter.createSupplierJob(node);
    first.tags.push("CORRUPTED");
    await adapter.supersedeJob(first.jobId, {
      actionKey: "supersede",
      traceId: "trace",
      reason: "offline",
    });
    expect((await adapter.createSupplierJob(node)).tags).toEqual([
      "MOLECULE_JOB",
      "plan:plan",
      "node:node",
    ]);
  });

  it("includes the job identity in supersession idempotency", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const node: SupplierJobPlanNode = {
      actionKey: "job1",
      traceId: "trace",
      shop: "stitchworks-test",
      planId: "plan",
      nodeId: "node1",
      lineItems: [{ title: "Embroidery", quantity: 50, price: "4.50" }],
    };
    const first = await adapter.createSupplierJob(node);
    const second = await adapter.createSupplierJob({
      ...node,
      actionKey: "job2",
      nodeId: "node2",
    });
    const reason = {
      actionKey: "supersede",
      traceId: "trace",
      reason: "offline",
    };
    await adapter.supersedeJob(first.jobId, reason);
    await expect(adapter.supersedeJob(second.jobId, reason)).rejects.toThrow(
      "ACTION_KEY_CONFLICT",
    );
  });

  it("returns isolated snapshots and catalog results", async () => {
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const before = await adapter.getSnapshot("stitchworks-test");
    const snapshot = await adapter.getSnapshot("stitchworks-test");
    snapshot.products[0]!.variants[0]!.optionValues.changed = "unexpected";
    snapshot.products[0]!.tags.push("unexpected");
    const results = await adapter.searchCatalog({
      shop: "stitchworks-test",
      limit: 1,
    });
    results[0]!.variants[0]!.optionValues.changed = "unexpected";
    expect(await adapter.getSnapshot("stitchworks-test")).toEqual(before);
  });

  it.each([-1, 0.5, NaN, Infinity])(
    "rejects invalid inventory %s without changing capacity",
    async (quantity) => {
      const adapter = new MockShopifyAdapter({ stores: STORES });
      const before = await adapter.getSnapshot("stitchworks-test");
      await expect(
        adapter.demoAdjustInventory(
          "stitchworks-test",
          before.capacity[0]!.itemId,
          quantity,
        ),
      ).rejects.toThrow();
      expect(await adapter.getSnapshot("stitchworks-test")).toEqual(before);
    },
  );

  it("shares the CLI catalog and filters results deterministically", async () => {
    const cli = await import(
      new URL("../../../../scripts/seed-data.mjs", import.meta.url).href
    );
    const fixtures = await import("@molecule/test-fixtures");
    expect(fixtures.catalogFor("stitchworks")).toEqual(
      cli.catalogFor("stitchworks"),
    );
    expect(fixtures.releaseCatalogFor("thread-forge")).toEqual(
      cli.releaseCatalogFor("thread-forge"),
    );
    const adapter = new MockShopifyAdapter({ stores: STORES });
    const results = await adapter.searchCatalog({
      role: "stitchworks",
      tag: "capacity",
      query: "capacity",
      limit: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.role).toBe("stitchworks");
    expect(results[0]!.tags).toContain("capacity");
    expect(await adapter.listMerchantCapacity()).toEqual(
      (await adapter.getSnapshot("stitchworks-test")).capacity,
    );
  });
});
