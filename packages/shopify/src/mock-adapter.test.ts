import { describe, expect, it } from "vitest";
import { MockShopifyAdapter } from "./mock-adapter.js";
import type { CompositeProductPlan, SupplierJobPlanNode } from "./types.js";

const STORES = ["stitchworks-test", "molecule-test"] as const;

describe("MockShopifyAdapter", () => {
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
    expect(result.invoiceUrl).toMatch(/^https:\/\//);
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
  });
});
