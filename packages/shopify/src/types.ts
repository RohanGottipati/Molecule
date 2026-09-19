import { createHash } from "node:crypto";
import {
  ExecutionActionReceiptSchema,
  ExecutionReceiptSchema,
  ProductionPlanSchema,
  type ExecutionReceipt,
  type ProductionPlan,
} from "@molecule/contracts";
import { z } from "zod";

export class ShopifyError extends Error {
  constructor(
    readonly code: string,
    readonly uncertain = false,
    readonly resource?: ShopifyResource,
  ) {
    super(`Shopify: ${code}`);
    this.name = "ShopifyError";
  }
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function actionKey(...parts: string[]): string {
  return `molecule:${digest(parts)}`;
}

export const ResourceSchema = z.object({
  id: z.string(),
  domain: z.string(),
  variantId: z.string().optional(),
  adminUrl: z.url().optional(),
  checkoutUrl: z.url().optional(),
  tags: z.array(z.string()).default([]),
  status: z.string().optional(),
  amount: z.string().optional(),
  currency: z.string().optional(),
});
export type ShopifyResource = z.infer<typeof ResourceSchema>;

export const EffectSchema = z.object({
  operation: z.enum(["product", "draft", "supersede"]),
  domain: z.string(),
  actionKey: z.string(),
  traceId: z.string(),
  orderId: z.string(),
  planId: z.string(),
  nodeId: z.string().optional(),
  merchantId: z.string().optional(),
  existing: ResourceSchema.optional(),
  handle: z.string().optional(),
  title: z.string(),
  amount: z.number().nonnegative(),
  currency: z.string(),
  variantId: z.string().optional(),
  quantity: z.number().int().positive().optional(),
  unitAmount: z.number().nonnegative().optional(),
  sku: z.string().optional(),
  attributes: z.record(z.string(), z.string()),
});
export type ShopifyEffect = z.infer<typeof EffectSchema>;

export const ActionRecordSchema = z.object({
  receipt: ExecutionActionReceiptSchema,
  effect: EffectSchema,
  resource: ResourceSchema.optional(),
});
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

export const OrderStateSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["mock", "real"]),
  binding: z.string(),
  orderId: z.string(),
  targetPlanId: z.string().optional(),
  plans: z.record(
    z.string(),
    z.object({
      plan: ProductionPlanSchema,
      fingerprint: z.string(),
      receipt: ExecutionReceiptSchema.optional(),
      superseded: z.boolean().default(false),
      reusedJobs: z.record(z.string(), ResourceSchema).default({}),
    }),
  ),
  actions: z.record(z.string(), ActionRecordSchema),
  mockResources: z.record(
    z.string(),
    z.object({ resource: ResourceSchema, effect: EffectSchema }),
  ),
});
export type ShopifyOrderState = z.infer<typeof OrderStateSchema>;

export interface ShopifyClient {
  commit(plan: ProductionPlan, traceId: string): Promise<ExecutionReceipt>;
  reconcile(plan: ProductionPlan, traceId: string): Promise<ExecutionReceipt>;
  supersede(
    orderId: string,
    planId: string,
    traceId: string,
  ): Promise<ExecutionReceipt>;
}

export function validatedPlan(
  input: ProductionPlan,
  traceId: string,
): ProductionPlan {
  const result = ProductionPlanSchema.safeParse(input);
  if (!result.success) throw new ShopifyError("INVALID_PLAN");
  const plan = result.data;
  if (
    plan.status !== "VALID" ||
    !plan.orderId ||
    !plan.planId ||
    !plan.nodes.length ||
    !plan.constraintResults.length ||
    plan.nodes.some(
      (node) =>
        !node.nodeId || !node.merchantId || !Number.isInteger(node.quantity),
    ) ||
    new Set(plan.nodes.map((node) => node.nodeId)).size !== plan.nodes.length ||
    !traceId.trim()
  )
    throw new ShopifyError("INVALID_PLAN");
  for (const cost of [
    plan.totalCost,
    ...plan.nodes.map((node) => node.totalCost),
  ]) {
    if (Math.abs(cost * 100 - Math.round(cost * 100)) > 1e-7) {
      throw new ShopifyError("UNSUPPORTED_MONEY_PRECISION");
    }
  }
  return plan;
}
