import {
  catalogFor,
  roleForStore,
  DEMO_STORE_HANDLES,
} from "@molecule/test-fixtures";
import {
  CatalogSearchFiltersSchema,
  CompositeProductPlanSchema,
  CustomerCheckoutPlanSchema,
  SupersedeJobReasonSchema,
  SupplierJobPlanNodeSchema,
} from "./types.js";
import type {
  CatalogSearchFilters,
  CatalogSearchResult,
  CompositeProductPlan,
  CustomerCheckoutPlan,
  CustomerCheckoutResult,
  DemoAdjustInventoryResult,
  ShopifyAdapter,
  ShopifyCapacityItem,
  ShopifyProductSnapshot,
  ShopifySnapshot,
  SupersedeJobReason,
  SupersedeJobResult,
  SupplierJobPlanNode,
  SupplierJobResult,
  UpsertCompositeProductResult,
} from "./types.js";

interface MockVariant {
  variantId: string;
  sku: string;
  optionValues: Record<string, string>;
  price: string;
  tracked: boolean;
  quantity: number | null;
}

interface MockProduct {
  productId: string;
  handle: string;
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  variants: MockVariant[];
}

interface MockDraftOrder {
  jobId: string;
  shop: string;
  tags: string[];
  attributes: Record<string, string>;
  lineItems: { title: string; quantity: number; price: string }[];
  invoiceUrl?: string;
}

export interface MockShopifyAdapterOptions {
  /** Store handles to seed. Defaults to the current Dev Dashboard org's stores. */
  stores?: readonly string[];
}

function toSnapshotProduct(product: MockProduct): ShopifyProductSnapshot {
  return {
    productId: product.productId,
    handle: product.handle,
    title: product.title,
    vendor: product.vendor,
    productType: product.productType,
    tags: [...product.tags],
    variants: product.variants.map((v) => ({ ...v })),
  };
}

/**
 * In-memory ShopifyAdapter. No network, no env — teammates can build against it directly.
 * Loads the SAME deterministic seed catalogs as scripts/seed-shopify.mjs via
 * @molecule/test-fixtures, so mock and real stores start from identical data.
 */
export class MockShopifyAdapter implements ShopifyAdapter {
  private readonly storeHandles: readonly string[];
  private stores = new Map<string, Map<string, MockProduct>>();
  private draftOrders = new Map<string, MockDraftOrder>();
  private actionResults = new Map<string, unknown>();
  private seq = 0;

  constructor(options: MockShopifyAdapterOptions = {}) {
    this.storeHandles = options.stores ?? DEMO_STORE_HANDLES;
    this.seedAll();
  }

  private nextId(kind: string): string {
    this.seq += 1;
    return `gid://shopify-mock/${kind}/${this.seq}`;
  }

  private seedAll(): void {
    this.stores.clear();
    this.draftOrders.clear();
    this.actionResults.clear();
    for (const shop of this.storeHandles) this.seedStore(shop);
  }

  private seedStore(shop: string): void {
    const role = roleForStore(shop);
    const products = new Map<string, MockProduct>();
    for (const p of catalogFor(role) as any[]) {
      const variants: MockVariant[] = p.variants.map((v: any) => ({
        variantId: this.nextId("ProductVariant"),
        sku: v.sku,
        optionValues: Object.fromEntries(
          v.optionValues.map((ov: { optionName: string; name: string }) => [
            ov.optionName,
            ov.name,
          ]),
        ),
        price: v.price,
        tracked: v.tracked,
        quantity: v.quantity,
      }));
      products.set(p.handle, {
        productId: this.nextId("Product"),
        handle: p.handle,
        title: p.title,
        vendor: p.vendor,
        productType: p.type,
        tags: [...p.tags],
        variants,
      });
    }
    this.stores.set(shop, products);
  }

  private requireStore(shop: string): Map<string, MockProduct> {
    const store = this.stores.get(shop);
    if (!store) throw new Error(`MockShopifyAdapter: unknown store "${shop}"`);
    return store;
  }

  async getSnapshot(shop: string): Promise<ShopifySnapshot> {
    const store = this.requireStore(shop);
    const role = roleForStore(shop);
    const products = [...store.values()];
    const capacity: ShopifyCapacityItem[] = products
      .filter((p) => p.tags.includes("capacity"))
      .map((p) => ({
        shop,
        role,
        itemId: p.variants[0]!.variantId,
        title: p.title,
        quantity: p.variants[0]!.quantity ?? 0,
      }));
    return {
      shop,
      role,
      capturedAt: new Date().toISOString(),
      capacity,
      products: products.map(toSnapshotProduct),
    };
  }

  async listMerchantCapacity(): Promise<ShopifyCapacityItem[]> {
    const out: ShopifyCapacityItem[] = [];
    for (const shop of this.storeHandles) {
      const snapshot = await this.getSnapshot(shop);
      out.push(...snapshot.capacity);
    }
    return out;
  }

  async searchCatalog(
    rawFilters: CatalogSearchFilters,
  ): Promise<CatalogSearchResult[]> {
    const filters = CatalogSearchFiltersSchema.parse(rawFilters);
    const results: CatalogSearchResult[] = [];
    for (const shop of this.storeHandles) {
      if (filters.shop && filters.shop !== shop) continue;
      const role = roleForStore(shop);
      if (filters.role && filters.role !== role) continue;
      for (const product of this.requireStore(shop).values()) {
        if (filters.tag && !product.tags.includes(filters.tag)) continue;
        if (filters.kind && !product.tags.includes(`kind:${filters.kind}`))
          continue;
        if (
          filters.query &&
          !product.title.toLowerCase().includes(filters.query.toLowerCase())
        )
          continue;
        results.push({ shop, role, ...toSnapshotProduct(product) });
        if (results.length >= filters.limit) return results;
      }
    }
    return results;
  }

  async upsertCompositeProduct(
    rawPlan: CompositeProductPlan,
  ): Promise<UpsertCompositeProductResult> {
    const plan = CompositeProductPlanSchema.parse(rawPlan);
    const cached = this.actionResults.get(plan.actionKey) as
      UpsertCompositeProductResult | undefined;
    if (cached) return cached;

    const shop =
      this.storeHandles.find((s) => roleForStore(s) === "molecule") ??
      this.storeHandles[0]!;
    const store = this.requireStore(shop);
    const handle = `molecule-${plan.orderId}-v${plan.intentVersion}`;
    const existing = store.get(handle);
    const productId = existing?.productId ?? this.nextId("Product");
    const variants: MockVariant[] = plan.variants.map((v) => ({
      variantId: this.nextId("ProductVariant"),
      sku: v.sku,
      optionValues: v.optionValues,
      price: v.price,
      tracked: false,
      quantity: null,
    }));
    store.set(handle, {
      productId,
      handle,
      title: plan.title,
      vendor: "Molecule",
      productType: "Composite",
      tags: ["MOLECULE_DEMO", "MOLECULE_PLAN", `plan:${plan.planId}`],
      variants,
    });
    const result: UpsertCompositeProductResult = {
      productId,
      handle,
      created: !existing,
    };
    this.actionResults.set(plan.actionKey, result);
    return result;
  }

  async createSupplierJob(
    rawNode: SupplierJobPlanNode,
  ): Promise<SupplierJobResult> {
    const node = SupplierJobPlanNodeSchema.parse(rawNode);
    const cached = this.actionResults.get(node.actionKey) as
      SupplierJobResult | undefined;
    if (cached) return cached;

    this.requireStore(node.shop);
    const jobId = this.nextId("DraftOrder");
    const tags = ["MOLECULE_JOB", `plan:${node.planId}`, `node:${node.nodeId}`];
    this.draftOrders.set(jobId, {
      jobId,
      shop: node.shop,
      tags,
      attributes: node.attributes,
      lineItems: node.lineItems,
    });
    const result: SupplierJobResult = {
      jobId,
      shop: node.shop,
      created: true,
      tags,
    };
    this.actionResults.set(node.actionKey, result);
    return result;
  }

  async supersedeJob(
    jobId: string,
    rawReason: SupersedeJobReason,
  ): Promise<SupersedeJobResult> {
    const reason = SupersedeJobReasonSchema.parse(rawReason);
    const cached = this.actionResults.get(reason.actionKey) as
      SupersedeJobResult | undefined;
    if (cached) return cached;

    const job = this.draftOrders.get(jobId);
    if (!job) throw new Error(`MockShopifyAdapter: unknown job "${jobId}"`);
    if (!job.tags.includes("MOLECULE_SUPERSEDED"))
      job.tags.push("MOLECULE_SUPERSEDED");
    const result: SupersedeJobResult = {
      jobId,
      superseded: true,
      tags: [...job.tags],
    };
    this.actionResults.set(reason.actionKey, result);
    return result;
  }

  async createCustomerCheckout(
    rawPlan: CustomerCheckoutPlan,
  ): Promise<CustomerCheckoutResult> {
    const plan = CustomerCheckoutPlanSchema.parse(rawPlan);
    const cached = this.actionResults.get(plan.actionKey) as
      CustomerCheckoutResult | undefined;
    if (cached) return cached;

    this.requireStore(plan.shop);
    const draftOrderId = this.nextId("DraftOrder");
    const invoiceUrl = `https://${plan.shop}.myshopify.com/admin/draft_orders/${encodeURIComponent(draftOrderId)}/invoice_mock`;
    this.draftOrders.set(draftOrderId, {
      jobId: draftOrderId,
      shop: plan.shop,
      tags: ["MOLECULE_CHECKOUT", `plan:${plan.planId}`],
      attributes: {},
      lineItems: [
        { title: plan.lineItemTitle, quantity: 1, price: plan.price },
      ],
      invoiceUrl,
    });
    const result: CustomerCheckoutResult = {
      draftOrderId,
      invoiceUrl,
      created: true,
    };
    this.actionResults.set(plan.actionKey, result);
    return result;
  }

  async demoAdjustInventory(
    shop: string,
    itemId: string,
    quantity: number,
  ): Promise<DemoAdjustInventoryResult> {
    const store = this.requireStore(shop);
    for (const product of store.values()) {
      const variant = product.variants.find(
        (v) => v.variantId === itemId || v.sku === itemId,
      );
      if (variant) {
        variant.quantity = quantity;
        return { shop, itemId, quantity };
      }
    }
    throw new Error(
      `MockShopifyAdapter: unknown inventory item "${itemId}" in ${shop}`,
    );
  }

  async reset(): Promise<void> {
    this.seedAll();
  }
}
