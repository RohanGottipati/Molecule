import { z } from "zod";
import { CurrencySchema } from "@molecule/contracts";

// Shopify reads become Tiger claims of type SHOPIFY_SNAPSHOT (see docs/TASKS/SHOPIFY_LOOP.md section 2).
// This adapter never decides feasibility; the solver alone certifies plans.

export const ActionKeySchema = z.string().min(1);
export const TraceIdSchema = z.string().min(1);
const PriceSchema = z
  .string()
  .regex(/^\d+(?:\.\d{1,2})?$/)
  .refine((value) => Number.isFinite(Number(value)));

export const ShopifyVariantSnapshotSchema = z.object({
  variantId: z.string().min(1),
  // Shopify allows unset SKUs; an empty value preserves that unknown fact.
  // variantId remains the identity even when multiple variants have no SKU.
  sku: z.string(),
  optionValues: z.record(z.string(), z.string()),
  price: z.string().min(1),
  tracked: z.boolean(),
  quantity: z.number().int().nonnegative().nullable(),
});
export type ShopifyVariantSnapshot = z.infer<
  typeof ShopifyVariantSnapshotSchema
>;

export const ShopifyProductSnapshotSchema = z.object({
  productId: z.string().min(1),
  handle: z.string().min(1),
  title: z.string().min(1),
  vendor: z.string(),
  productType: z.string(),
  tags: z.array(z.string()),
  variants: z.array(ShopifyVariantSnapshotSchema),
});
export type ShopifyProductSnapshot = z.infer<
  typeof ShopifyProductSnapshotSchema
>;

export const ShopifyCapacityItemSchema = z.object({
  shop: z.string().min(1),
  role: z.string().min(1),
  itemId: z.string().min(1),
  title: z.string().min(1),
  quantity: z.number().int().nonnegative().nullable(),
});
export type ShopifyCapacityItem = z.infer<typeof ShopifyCapacityItemSchema>;

export const ShopifySnapshotSchema = z.object({
  shop: z.string().min(1),
  role: z.string().min(1),
  capturedAt: z.iso.datetime(),
  capacity: z.array(ShopifyCapacityItemSchema),
  products: z.array(ShopifyProductSnapshotSchema),
});
export type ShopifySnapshot = z.infer<typeof ShopifySnapshotSchema>;

export const CatalogSearchFiltersSchema = z.object({
  shop: z.string().optional(),
  role: z.string().optional(),
  tag: z.string().optional(),
  kind: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().max(250).default(50),
});
export type CatalogSearchFilters = z.input<typeof CatalogSearchFiltersSchema>;

export const CatalogSearchResultSchema = ShopifyProductSnapshotSchema.extend({
  shop: z.string().min(1),
  role: z.string().min(1),
});
export type CatalogSearchResult = z.infer<typeof CatalogSearchResultSchema>;

export const CompositeVariantInputSchema = z.object({
  optionValues: z.record(z.string(), z.string()),
  price: PriceSchema,
  sku: z.string().min(1),
});

export const CompositeProductPlanSchema = z.object({
  actionKey: ActionKeySchema,
  traceId: TraceIdSchema,
  orderId: z.string().min(1),
  planId: z.string().min(1),
  intentVersion: z.number().int().positive(),
  title: z.string().min(1),
  options: z.record(z.string(), z.array(z.string())).default({}),
  variants: z.array(CompositeVariantInputSchema).min(1),
  riskScore: z.number().min(0).max(1),
  p95: z.string().optional(),
  provenance: z.string().max(600),
});
export type CompositeProductPlan = z.input<typeof CompositeProductPlanSchema>;

export const UpsertCompositeProductResultSchema = z.object({
  productId: z.string().min(1),
  handle: z.string().min(1),
  created: z.boolean(),
});
export type UpsertCompositeProductResult = z.infer<
  typeof UpsertCompositeProductResultSchema
>;

export const SupplierJobLineItemSchema = z.object({
  title: z.string().min(1),
  quantity: z.number().int().positive(),
  price: PriceSchema,
});

export const SupplierJobPlanNodeSchema = z.object({
  actionKey: ActionKeySchema,
  traceId: TraceIdSchema,
  shop: z.string().min(1),
  planId: z.string().min(1),
  nodeId: z.string().min(1),
  lineItems: z.array(SupplierJobLineItemSchema).min(1),
  attributes: z.record(z.string(), z.string()).default({}),
});
export type SupplierJobPlanNode = z.input<typeof SupplierJobPlanNodeSchema>;

export const SupplierJobResultSchema = z.object({
  jobId: z.string().min(1),
  shop: z.string().min(1),
  created: z.boolean(),
  tags: z.array(z.string()),
});
export type SupplierJobResult = z.infer<typeof SupplierJobResultSchema>;

export const SupersedeJobReasonSchema = z.object({
  actionKey: ActionKeySchema,
  traceId: TraceIdSchema,
  reason: z.string().min(1),
});
export type SupersedeJobReason = z.input<typeof SupersedeJobReasonSchema>;

export const SupersedeJobResultSchema = z.object({
  jobId: z.string().min(1),
  superseded: z.boolean(),
  tags: z.array(z.string()),
});
export type SupersedeJobResult = z.infer<typeof SupersedeJobResultSchema>;

export const CustomerCheckoutPlanSchema = z.object({
  actionKey: ActionKeySchema,
  traceId: TraceIdSchema,
  shop: z.string().min(1),
  orderId: z.string().min(1),
  planId: z.string().min(1),
  lineItemTitle: z.string().min(1),
  price: PriceSchema,
  currency: CurrencySchema,
});
export type CustomerCheckoutPlan = z.input<typeof CustomerCheckoutPlanSchema>;

export const CustomerCheckoutResultSchema = z.object({
  draftOrderId: z.string().min(1),
  invoiceUrl: z.url(),
  created: z.boolean(),
});
export type CustomerCheckoutResult = z.infer<
  typeof CustomerCheckoutResultSchema
>;

export const DemoAdjustInventoryResultSchema = z.object({
  shop: z.string().min(1),
  itemId: z.string().min(1),
  quantity: z.number().int().nonnegative(),
});
export type DemoAdjustInventoryResult = z.infer<
  typeof DemoAdjustInventoryResultSchema
>;

/**
 * Only the orchestrator calls this. Every write method is idempotent by `actionKey`: calling it
 * twice with the same actionKey returns the first call's result instead of creating a duplicate
 * resource (docs/TASKS/SHOPIFY_LOOP.md section 2).
 */
export interface ShopifyAdapter {
  getSnapshot(shop: string): Promise<ShopifySnapshot>;
  listMerchantCapacity(): Promise<ShopifyCapacityItem[]>;
  searchCatalog(filters: CatalogSearchFilters): Promise<CatalogSearchResult[]>;
  upsertCompositeProduct(
    plan: CompositeProductPlan,
  ): Promise<UpsertCompositeProductResult>;
  createSupplierJob(planNode: SupplierJobPlanNode): Promise<SupplierJobResult>;
  supersedeJob(
    jobId: string,
    reason: SupersedeJobReason,
  ): Promise<SupersedeJobResult>;
  createCustomerCheckout(
    plan: CustomerCheckoutPlan,
  ): Promise<CustomerCheckoutResult>;
  demoAdjustInventory(
    shop: string,
    itemId: string,
    quantity: number,
  ): Promise<DemoAdjustInventoryResult>;
  reset(): Promise<void>;
}
