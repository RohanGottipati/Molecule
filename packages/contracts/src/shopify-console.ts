import { z } from "zod";

/**
 * Read models for the store console.
 *
 * These are presentation shapes over the `shopify_*` mirror tables, not new domain facts. They
 * never redefine a domain shape: catalog identity still comes from `CatalogVariantSchema` and
 * `SelectedCatalogItemSchema`, and nothing here is an input to Reality, the solver, or claim
 * resolution.
 *
 * ## Provenance
 *
 * Every payload states where its rows came from, and the discriminator is required so no caller
 * can mistake synthetic records for provider-backed ones:
 *
 *   - `provider_backed` - read from a granted Shopify scope against a real store.
 *   - `synthetic`       - generated locally by the fake Admin API (SHOPIFY_MODE=fake).
 *   - `synthetic_only`  - has NO live counterpart and never will, because the scope that would
 *                         produce it is not granted. Customers and sales rollups are always
 *                         this: `read_customers` is not among the granted scopes
 *                         (docs/TASKS/SHOPIFY_LOOP.md section 1).
 *
 * A `synthetic_only` surface is a display aid. Treating it as operational truth would violate
 * the "never guess operational truth" rule in AGENTS.md.
 */

export const StoreProvenanceSchema = z.enum([
  "provider_backed",
  "synthetic",
  "synthetic_only",
]);
export type StoreProvenance = z.infer<typeof StoreProvenanceSchema>;

/** Provenance for surfaces that can never be provider-backed. */
export const SyntheticOnlyProvenanceSchema = z.literal("synthetic_only");

const ShopDomainSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);
const MoneySchema = z.string().regex(/^-?\d+(?:\.\d{1,2})?$/);

export const StoreSummarySchema = z.object({
  shopDomain: ShopDomainSchema,
  merchantId: z.string().min(1),
  merchantName: z.string(),
  productCount: z.number().int().nonnegative(),
  variantCount: z.number().int().nonnegative(),
  trackedVariantCount: z.number().int().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  customerCount: z.number().int().nonnegative(),
  syncedAt: z.iso.datetime().nullable(),
  provenance: StoreProvenanceSchema,
});
export type StoreSummary = z.infer<typeof StoreSummarySchema>;

export const StoreListSchema = z.object({
  capturedAt: z.iso.datetime(),
  mode: z.enum(["live", "demo", "fake"]),
  stores: z.array(StoreSummarySchema),
});
export type StoreList = z.infer<typeof StoreListSchema>;

export const StoreVariantSchema = z.object({
  variantGid: z.string().min(1),
  sku: z.string().nullable(),
  title: z.string().nullable(),
  price: MoneySchema.nullable(),
  currency: z.string().nullable(),
  tracked: z.boolean(),
  /** null is an unknown quantity, never a zero. */
  available: z.number().int().nullable(),
  inventoryItemGid: z.string().nullable(),
});
export type StoreVariant = z.infer<typeof StoreVariantSchema>;

export const StoreProductSchema = z.object({
  productGid: z.string().min(1),
  handle: z.string().min(1),
  title: z.string().min(1),
  productType: z.string().nullable(),
  vendor: z.string().nullable(),
  status: z.string(),
  tags: z.array(z.string()),
  variants: z.array(StoreVariantSchema),
});
export type StoreProduct = z.infer<typeof StoreProductSchema>;

export const StoreCatalogSchema = z.object({
  capturedAt: z.iso.datetime(),
  shopDomain: ShopDomainSchema,
  merchantId: z.string().min(1),
  provenance: StoreProvenanceSchema,
  total: z.number().int().nonnegative(),
  products: z.array(StoreProductSchema),
});
export type StoreCatalog = z.infer<typeof StoreCatalogSchema>;

export const StoreOrderLineItemSchema = z.object({
  lineItemGid: z.string().min(1),
  title: z.string(),
  quantity: z.number().int().positive(),
  sku: z.string().nullable(),
  variantGid: z.string().nullable(),
  productGid: z.string().nullable(),
  unitPrice: MoneySchema,
  totalPrice: MoneySchema,
});
export type StoreOrderLineItem = z.infer<typeof StoreOrderLineItemSchema>;

export const StoreOrderSchema = z.object({
  orderGid: z.string().min(1),
  name: z.string(),
  createdAt: z.iso.datetime(),
  financialStatus: z.string().nullable(),
  fulfillmentStatus: z.string().nullable(),
  currency: z.string(),
  subtotal: MoneySchema,
  total: MoneySchema,
  customerGid: z.string().nullable(),
  customerName: z.string().nullable(),
  tags: z.array(z.string()),
  synthetic: z.boolean(),
  lineItems: z.array(StoreOrderLineItemSchema),
});
export type StoreOrder = z.infer<typeof StoreOrderSchema>;

export const StoreOrdersSchema = z.object({
  capturedAt: z.iso.datetime(),
  shopDomain: ShopDomainSchema,
  merchantId: z.string().min(1),
  provenance: StoreProvenanceSchema,
  total: z.number().int().nonnegative(),
  orders: z.array(StoreOrderSchema),
});
export type StoreOrders = z.infer<typeof StoreOrdersSchema>;

export const StoreCustomerSchema = z.object({
  customerGid: z.string().min(1),
  displayName: z.string(),
  email: z.string().nullable(),
  createdAt: z.iso.datetime(),
  orderCount: z.number().int().nonnegative(),
  amountSpent: MoneySchema,
  currency: z.string(),
  tags: z.array(z.string()),
});
export type StoreCustomer = z.infer<typeof StoreCustomerSchema>;

export const StoreCustomersSchema = z.object({
  capturedAt: z.iso.datetime(),
  shopDomain: ShopDomainSchema,
  merchantId: z.string().min(1),
  // `read_customers` is not a granted scope, so this can never be provider-backed.
  provenance: SyntheticOnlyProvenanceSchema,
  total: z.number().int().nonnegative(),
  customers: z.array(StoreCustomerSchema),
});
export type StoreCustomers = z.infer<typeof StoreCustomersSchema>;

export const StoreSalesDaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  orderCount: z.number().int().nonnegative(),
  units: z.number().int().nonnegative(),
  grossSales: MoneySchema,
});
export type StoreSalesDay = z.infer<typeof StoreSalesDaySchema>;

export const StoreTopProductSchema = z.object({
  productGid: z.string().nullable(),
  title: z.string(),
  units: z.number().int().nonnegative(),
  grossSales: MoneySchema,
});
export type StoreTopProduct = z.infer<typeof StoreTopProductSchema>;

export const StoreAnalyticsSchema = z.object({
  capturedAt: z.iso.datetime(),
  shopDomain: ShopDomainSchema,
  merchantId: z.string().min(1),
  // Derived entirely from synthetic orders; it has no live equivalent.
  provenance: SyntheticOnlyProvenanceSchema,
  // Whatever the store reports. Narrowing this to CAD/USD would invent a constraint the
  // mirror does not enforce.
  currency: z.string().min(1),
  totals: z.object({
    orderCount: z.number().int().nonnegative(),
    units: z.number().int().nonnegative(),
    grossSales: MoneySchema,
    averageOrderValue: MoneySchema,
  }),
  daily: z.array(StoreSalesDaySchema),
  topProducts: z.array(StoreTopProductSchema),
});
export type StoreAnalytics = z.infer<typeof StoreAnalyticsSchema>;
