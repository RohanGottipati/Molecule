import { createHash } from "node:crypto";
import {
  ExecutionReceiptSchema,
  type ExecutionActionReceipt,
  type ExecutionReceipt,
  type ProductionPlan,
} from "@molecule/contracts";

import type { ShopifyClient } from "../clients.js";

export class MockShopifyClient implements ShopifyClient {
  private readonly refs = new Map<string, string>();

  private ref(actionKey: string, prefix: string): string {
    const current = this.refs.get(actionKey);
    if (current) return current;
    const created = `gid://mock/${prefix}/${createHash("sha256").update(actionKey).digest("hex")}`;
    this.refs.set(actionKey, created);
    return created;
  }

  async commit(
    plan: ProductionPlan,
    _traceId: string,
  ): Promise<ExecutionReceipt> {
    const productKey = `composite-product:${plan.orderId}:${plan.intentVersion}`;
    const productGid = this.ref(productKey, "Product");
    const actions: ExecutionActionReceipt[] = [
      {
        actionKey: productKey,
        kind: "COMPOSITE_PRODUCT",
        status: "SUCCEEDED",
        providerRef: productGid,
      },
    ];
    const supplierJobs = plan.nodes.map((node) => {
      const actionKey = `supplier-job:${plan.orderId}:${plan.planId}:${node.nodeId}`;
      const draftOrderGid = this.ref(actionKey, "DraftOrder");
      actions.push({
        actionKey,
        kind: "SUPPLIER_JOB",
        status: "SUCCEEDED",
        providerRef: draftOrderGid,
      });
      return {
        merchantId: node.merchantId,
        nodeId: node.nodeId,
        draftOrderGid,
        storeDomain: `${node.merchantId}.example.test`,
      };
    });
    const customerKey = `customer-order:${plan.orderId}:${plan.intentVersion}`;
    const customerOrder = this.ref(customerKey, "DraftOrder");
    actions.push({
      actionKey: customerKey,
      kind: "CUSTOMER_ORDER",
      status: "SUCCEEDED",
      providerRef: customerOrder,
    });

    return ExecutionReceiptSchema.parse({
      orderId: plan.orderId,
      planId: plan.planId,
      intentVersion: plan.intentVersion,
      actions,
      compositeProduct: {
        storeDomain: "molecule.example.test",
        productGid,
        adminUrl: `https://molecule.example.test/admin/products/${encodeURIComponent(productGid)}`,
      },
      customerOrder: { draftOrderGid: customerOrder },
      supplierJobs,
    });
  }
}
