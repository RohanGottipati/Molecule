import type { ExecutionReceipt, ProductionPlan } from "@molecule/contracts";
import { getPool, releaseReservation, reserveCapacity } from "@molecule/db";
import type { MerchantRuntime } from "@molecule/merchant-agents";
import type { ShopifyClient } from "@molecule/shopify";
import { ExecutionInterruptedError } from "./ExecutionInterruptedError.js";

export class DurableExecutionClient implements ShopifyClient {
  constructor(
    private readonly shopify: ShopifyClient,
    private readonly merchants: MerchantRuntime,
  ) {}

  private async release(orderId: string, planId: string, traceId: string) {
    const rows = await getPool().query<{ reservation_id: string }>(
      "select reservation_id from reservations where order_id=$1 and action_key like $2 and status='active'",
      [orderId, `execution:${planId}:%`],
    );
    for (const row of rows.rows)
      await releaseReservation(row.reservation_id, traceId);
  }

  async commit(
    plan: ProductionPlan,
    traceId: string,
  ): Promise<ExecutionReceipt> {
    try {
      for (const node of plan.nodes) {
        const reserved = await reserveCapacity({
          merchantId: node.merchantId,
          capabilityId: node.capabilityId,
          orderId: plan.orderId,
          quantity: node.quantity,
          traceId,
          actionKey: `execution:${plan.planId}:${node.nodeId}`,
          ttlSeconds: 86400,
        });
        if (!reserved.ok)
          throw new Error("Supplier capacity changed; replan before execution");
      }
    } catch (error) {
      await this.release(plan.orderId, plan.planId, traceId);
      throw error;
    }
    const receipt = await this.shopify.commit(plan, traceId);
    if (
      receipt.actions.some(
        ({ status }) => !["SUCCEEDED", "COMPENSATED"].includes(status),
      )
    )
      return receipt;
    try {
      for (const node of plan.nodes) {
        await this.merchants.jobs.acceptJob({
          merchantId: node.merchantId,
          orderId: plan.orderId,
          nodeId: node.nodeId,
          eta: node.completesAt,
          traceId,
          actionKey: `execution:${plan.planId}:${node.nodeId}:accept`,
        });
        await this.merchants.recordMemory({
          merchantId: node.merchantId,
          orderId: plan.orderId,
          traceId,
          note: `${this.merchants.mode === "demo" ? "Synthetic: " : ""}Accepted ${node.quantity} units of ${node.capabilityId} for order ${plan.orderId}; plan ${plan.planId}.`,
        });
      }
    } catch {
      throw new ExecutionInterruptedError(receipt);
    }
    return receipt;
  }
  reconcile(plan: ProductionPlan, traceId: string) {
    return this.shopify.reconcile(plan, traceId);
  }
  async supersede(orderId: string, planId: string, traceId: string) {
    const receipt = await this.shopify.supersede(orderId, planId, traceId);
    if (
      receipt.actions.some(
        ({ status }) => !["SUCCEEDED", "COMPENSATED"].includes(status),
      )
    )
      throw new ExecutionInterruptedError(receipt);
    try {
      await this.release(orderId, planId, traceId);
    } catch {
      throw new ExecutionInterruptedError(receipt);
    }
    return receipt;
  }
}
