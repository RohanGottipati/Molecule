import {
  CatalogGallerySchema,
  GOLDEN_PATH_PROMPT,
  StoreListSchema,
  StoreCatalogSchema,
  StoreOrdersSchema,
  StoreCustomersSchema,
  StoreAnalyticsSchema,
  type StoreOrder,
  type StoreProduct,
} from "@molecule/contracts";
import type { StoreConsole } from "../storeConsole.js";
import { demoCandidates } from "../mocks/demoCatalog.js";

/** Read-only display fixtures. Never inputs to quoting, planning, or execution. */
export function createDemoStoreConsole(): StoreConsole {
  const capturedAt = "2026-09-20T09:00:00.000Z";
  const candidates = demoCandidates();
  const merchantIds = [...new Set(candidates.map((c) => c.merchantId))];
  const names: Record<string, string> = {
    "base-goods": "Base Goods",
    "base-goods-2": "Base Goods Reserve",
    "snack-box": "Snack Box",
    "thread-forge": "Thread Forge",
    "stitch-works": "Stitch Works",
    "needle-north": "Needle North",
    "laser-lab": "Laser Lab",
    "pack-ship": "Pack & Ship",
  };
  const buyers = [
    "Northstar Studio",
    "Fieldwork Design",
    "Acorn Collective",
    "Meridian Labs",
  ];
  const records = merchantIds.map((merchantId, storeIndex) => {
    const shopDomain = `demo-${merchantId}.myshopify.com`;
    const merchantName = names[merchantId] ?? merchantId;
    const base = { capturedAt, shopDomain, merchantId };
    const products: StoreProduct[] = candidates
      .filter((c) => c.merchantId === merchantId)
      .map(({ capability: c }) => ({
        productGid: `demo:product:${c.capabilityId}`,
        handle: c.capabilityId,
        title: c.name,
        productType: c.kind === "SUPPLY" ? "Materials" : "Production service",
        vendor: merchantName,
        status: "ACTIVE",
        tags: ["demo", c.kind.toLowerCase()],
        variants: [
          {
            variantGid: `demo:variant:${c.capabilityId}`,
            sku: c.capabilityId.toUpperCase(),
            title: c.quantity.unit,
            price: c.pricing.unitPrice?.toFixed(2) ?? null,
            currency: "CAD",
            tracked: c.kind === "SUPPLY",
            available: c.kind === "SUPPLY" ? 800 + storeIndex * 25 : null,
            inventoryItemGid: null,
          },
        ],
      }));
    const orders: StoreOrder[] = Array.from({ length: 12 }, (_, i) => {
      const product = products[i % products.length]!;
      const variant = product.variants[0]!;
      const quantity = [50, 100, 200, 75][i % 4]!;
      const total = (Number(variant.price) * quantity).toFixed(2);
      return {
        orderGid: `demo:order:${merchantId}:${i}`,
        name: `#${2100 + storeIndex * 100 + i}`,
        createdAt: `2026-09-${String(19 - i).padStart(2, "0")}T14:30:00.000Z`,
        financialStatus: "PAID",
        fulfillmentStatus: i < 2 ? "UNFULFILLED" : "FULFILLED",
        currency: "CAD",
        subtotal: total,
        total,
        customerGid: `demo:customer:${i % 4}`,
        customerName: buyers[i % 4]!,
        tags: ["demo", "wholesale"],
        synthetic: true,
        lineItems: [
          {
            lineItemGid: `demo:line:${merchantId}:${i}`,
            title: product.title,
            quantity,
            sku: variant.sku,
            variantGid: variant.variantGid,
            productGid: product.productGid,
            unitPrice: variant.price!,
            totalPrice: total,
          },
        ],
      };
    });
    const customers = buyers.map((displayName, i) => {
      const purchases = orders.filter(
        (o) => o.customerGid === `demo:customer:${i}`,
      );
      return {
        customerGid: `demo:customer:${i}`,
        displayName,
        email: `orders@${displayName.toLowerCase().replaceAll(" ", "-")}.example`,
        createdAt: "2026-08-01T12:00:00.000Z",
        orderCount: purchases.length,
        amountSpent: purchases
          .reduce((n, o) => n + Number(o.total), 0)
          .toFixed(2),
        currency: "CAD",
        tags: ["wholesale", "demo"],
      };
    });
    const gross = orders.reduce((n, o) => n + Number(o.total), 0);
    const units = orders.reduce((n, o) => n + o.lineItems[0]!.quantity, 0);
    return {
      summary: {
        shopDomain,
        merchantId,
        merchantName,
        productCount: products.length,
        variantCount: products.length,
        trackedVariantCount: products.filter((p) => p.variants[0]!.tracked)
          .length,
        orderCount: orders.length,
        customerCount: customers.length,
        syncedAt: capturedAt,
        provenance: "synthetic" as const,
      },
      catalog: StoreCatalogSchema.parse({
        ...base,
        provenance: "synthetic",
        total: products.length,
        products,
      }),
      orders: StoreOrdersSchema.parse({
        ...base,
        provenance: "synthetic",
        total: orders.length,
        orders,
      }),
      customers: StoreCustomersSchema.parse({
        ...base,
        provenance: "synthetic_only",
        total: customers.length,
        customers,
      }),
      analytics: StoreAnalyticsSchema.parse({
        ...base,
        provenance: "synthetic_only",
        currency: "CAD",
        totals: {
          orderCount: orders.length,
          units,
          grossSales: gross.toFixed(2),
          averageOrderValue: (gross / orders.length).toFixed(2),
        },
        daily: [...orders].reverse().map((o) => ({
          day: o.createdAt.slice(0, 10),
          orderCount: 1,
          units: o.lineItems[0]!.quantity,
          grossSales: o.total,
        })),
        topProducts: products
          .map((p) => {
            const lines = orders
              .flatMap((o) => o.lineItems)
              .filter((l) => l.productGid === p.productGid);
            return {
              productGid: p.productGid,
              title: p.title,
              units: lines.reduce((n, l) => n + l.quantity, 0),
              grossSales: lines
                .reduce((n, l) => n + Number(l.totalPrice), 0)
                .toFixed(2),
            };
          })
          .sort((a, b) => Number(b.grossSales) - Number(a.grossSales)),
      }),
    };
  });
  const find = (domain: string) =>
    records.find((r) => r.summary.shopDomain === domain);
  return {
    async list() {
      return StoreListSchema.parse({
        capturedAt,
        mode: "demo",
        stores: records.map((r) => r.summary),
      });
    },
    async catalog(domain, limit) {
      const r = find(domain)?.catalog;
      return r && { ...r, products: r.products.slice(0, limit) };
    },
    async orders(domain, limit) {
      const r = find(domain)?.orders;
      return r && { ...r, orders: r.orders.slice(0, limit) };
    },
    async customers(domain, limit) {
      const r = find(domain)?.customers;
      return r && { ...r, customers: r.customers.slice(0, limit) };
    },
    async analytics(domain) {
      return find(domain)?.analytics;
    },
  };
}

export async function demoRecipeGallery() {
  const recipes = [
    {
      id: "premium-onboarding-kit",
      category: "Team kits",
      prompt: GOLDEN_PATH_PROMPT,
      outputKind: "bundle",
      operations: [
        "Supply",
        "Embroidery",
        "Engraving",
        "Assembly",
        "Fulfillment",
      ],
      connectedSuppliers: [
        "Base Goods",
        "Thread Forge",
        "Laser Lab",
        "Snack Box",
        "Pack & Ship",
      ],
    },
    {
      id: "embroidered-team-hoodies",
      category: "Apparel",
      prompt:
        "Make 100 premium black cotton hoodies with our embroidered logo. No leather. Deliver individually packed.",
      outputKind: "individual",
      operations: ["Supply", "Embroidery", "Packaging"],
      connectedSuppliers: ["Base Goods", "Thread Forge", "Pack & Ship"],
    },
    {
      id: "personalized-steel-bottles",
      category: "Accessories",
      prompt:
        "Create 200 black stainless steel bottles, each engraved with a recipient's name, with individual packaging.",
      outputKind: "individual",
      operations: ["Supply", "Engraving", "Packaging"],
      connectedSuppliers: ["Base Goods", "Laser Lab", "Pack & Ship"],
    },
    {
      id: "plant-based-welcome-box",
      category: "Team kits",
      prompt:
        "Build 100 welcome boxes with vegan snacks and a personalized black steel bottle, individually packed.",
      outputKind: "bundle",
      operations: ["Supply", "Engraving", "Assembly"],
      connectedSuppliers: [
        "Snack Box",
        "Base Goods",
        "Laser Lab",
        "Pack & Ship",
      ],
    },
    {
      id: "conference-speaker-gifts",
      category: "Events",
      prompt:
        "Prepare 50 speaker gifts with a black hoodie, an engraved bottle and vegan snacks in individual boxes.",
      outputKind: "bundle",
      operations: ["Supply", "Engraving", "Assembly", "Fulfillment"],
      connectedSuppliers: [
        "Base Goods",
        "Laser Lab",
        "Snack Box",
        "Pack & Ship",
      ],
    },
    {
      id: "studio-essentials",
      category: "Apparel",
      prompt:
        "Make 75 black cotton hoodies with a small embroidered studio logo and individual packaging. No polyester.",
      outputKind: "individual",
      operations: ["Supply", "Embroidery", "Packaging"],
      connectedSuppliers: ["Base Goods", "Needle North", "Pack & Ship"],
    },
  ];
  return CatalogGallerySchema.parse({
    catalogVersion: "demo-preview",
    recipes: recipes.map((r, i) => ({
      ...r,
      id: `recipe:${r.id}`,
      readiness: i === 0 ? "ready_for_solver" : "missing_evidence",
      missingEvidence:
        i === 0
          ? []
          : [
              "Confirm quantities, budget and deadline, then request supplier quotes and solver validation.",
            ],
      synthetic: true,
      verifiedAt: null,
    })),
  });
}
