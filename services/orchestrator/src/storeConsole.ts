import { getPool } from "@molecule/db";
import {
  StoreAnalyticsSchema,
  StoreCatalogSchema,
  StoreCustomersSchema,
  StoreListSchema,
  StoreOrdersSchema,
  type StoreAnalytics,
  type StoreCatalog,
  type StoreCustomers,
  type StoreList,
  type StoreOrders,
  type StoreProvenance,
} from "@molecule/contracts";
import type { Config } from "./config.js";

/**
 * Read model for the store console.
 *
 * Every query reads the `shopify_*` mirror tables, never a provider adapter, so live and fake
 * mode serve byte-identical shapes and the UI cannot tell which pipeline filled them. That is
 * the point: the console exercises the same read path in both modes.
 *
 * Nothing here feeds Reality, the solver, or claim resolution.
 */

function money(value: unknown): string {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
}

function iso(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

function day(value: unknown): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

export interface StoreConsole {
  list(): Promise<StoreList>;
  catalog(shopDomain: string, limit: number): Promise<StoreCatalog | undefined>;
  orders(shopDomain: string, limit: number): Promise<StoreOrders | undefined>;
  customers(
    shopDomain: string,
    limit: number,
  ): Promise<StoreCustomers | undefined>;
  analytics(shopDomain: string): Promise<StoreAnalytics | undefined>;
}

export function createStoreConsole(config: Config): StoreConsole {
  const mode: StoreList["mode"] =
    config.SHOPIFY_MODE === "live"
      ? "live"
      : config.SHOPIFY_MODE === "fake"
        ? "fake"
        : "demo";
  // Catalog and order rows are provider-backed only when they were pulled from a real store.
  const provenance: StoreProvenance =
    config.SHOPIFY_MODE === "live" ? "provider_backed" : "synthetic";

  async function merchantFor(
    shopDomain: string,
  ): Promise<string | undefined> {
    const result = await getPool().query<{ merchant_id: string }>(
      "select merchant_id from shopify_products where shop_domain=$1 limit 1",
      [shopDomain],
    );
    return result.rows[0]?.merchant_id;
  }

  return {
    async list(): Promise<StoreList> {
      const result = await getPool().query<{
        shop_domain: string;
        merchant_id: string;
        merchant_name: string | null;
        product_count: string;
        variant_count: string;
        tracked_variant_count: string;
        order_count: string;
        customer_count: string;
        synced_at: Date | null;
      }>(
        `select s.shop_domain, s.merchant_id, m.name as merchant_name,
                s.product_count, s.variant_count, s.tracked_variant_count, s.synced_at,
                coalesce(o.count, 0) as order_count,
                coalesce(c.count, 0) as customer_count
         from shopify_store_summary s
         left join merchants m on m.merchant_id = s.merchant_id
         left join (select shop_domain, count(*) as count from shopify_orders group by shop_domain) o
           on o.shop_domain = s.shop_domain
         left join (select shop_domain, count(*) as count from shopify_customers group by shop_domain) c
           on c.shop_domain = s.shop_domain
         order by s.shop_domain`,
      );
      return StoreListSchema.parse({
        capturedAt: new Date().toISOString(),
        mode,
        stores: result.rows.map((row) => ({
          shopDomain: row.shop_domain,
          merchantId: row.merchant_id,
          merchantName: row.merchant_name ?? row.merchant_id,
          productCount: Number(row.product_count),
          variantCount: Number(row.variant_count),
          trackedVariantCount: Number(row.tracked_variant_count),
          orderCount: Number(row.order_count),
          customerCount: Number(row.customer_count),
          syncedAt: row.synced_at ? iso(row.synced_at) : null,
          provenance,
        })),
      });
    },

    async catalog(shopDomain, limit) {
      const merchantId = await merchantFor(shopDomain);
      if (!merchantId) return undefined;
      const [products, total] = await Promise.all([
        getPool().query(
          `select p.product_gid, p.handle, p.title, p.product_type, p.vendor, p.status, p.tags,
                  coalesce(
                    jsonb_agg(
                      jsonb_build_object(
                        'variantGid', v.variant_gid, 'sku', v.sku, 'title', v.title,
                        'price', v.price, 'currency', v.currency, 'tracked', v.tracked,
                        'available', v.available, 'inventoryItemGid', v.inventory_item_gid
                      ) order by v.variant_gid
                    ) filter (where v.variant_gid is not null),
                    '[]'::jsonb
                  ) as variants
           from shopify_products p
           left join shopify_variants v on v.product_gid = p.product_gid
           where p.shop_domain=$1 and p.status <> 'MISSING'
           group by p.product_gid
           order by p.title
           limit $2`,
          [shopDomain, limit],
        ),
        getPool().query<{ count: string }>(
          "select count(*) from shopify_products where shop_domain=$1 and status <> 'MISSING'",
          [shopDomain],
        ),
      ]);
      return StoreCatalogSchema.parse({
        capturedAt: new Date().toISOString(),
        shopDomain,
        merchantId,
        provenance,
        total: Number(total.rows[0]?.count ?? 0),
        products: products.rows.map((row) => ({
          productGid: row.product_gid,
          handle: row.handle,
          title: row.title,
          productType: row.product_type,
          vendor: row.vendor,
          status: row.status,
          tags: row.tags ?? [],
          variants: (row.variants ?? []).map(
            (variant: Record<string, unknown>) => ({
              variantGid: String(variant.variantGid),
              sku: (variant.sku as string | null) ?? null,
              title: (variant.title as string | null) ?? null,
              price: variant.price == null ? null : money(variant.price),
              currency: (variant.currency as string | null) ?? null,
              tracked: Boolean(variant.tracked),
              // A null available is an unknown quantity; it must never become a zero.
              available:
                variant.available == null ? null : Number(variant.available),
              inventoryItemGid:
                (variant.inventoryItemGid as string | null) ?? null,
            }),
          ),
        })),
      });
    },

    async orders(shopDomain, limit) {
      const merchantId = await merchantFor(shopDomain);
      if (!merchantId) return undefined;
      const [orders, total] = await Promise.all([
        getPool().query(
          `select o.order_gid, o.name, o.created_at, o.financial_status, o.fulfillment_status,
                  o.currency, o.subtotal, o.total, o.customer_gid, o.tags, o.synthetic,
                  c.display_name as customer_name,
                  coalesce(
                    jsonb_agg(
                      jsonb_build_object(
                        'lineItemGid', l.line_item_gid, 'title', l.title, 'quantity', l.quantity,
                        'sku', l.sku, 'variantGid', l.variant_gid, 'productGid', l.product_gid,
                        'unitPrice', l.unit_price, 'totalPrice', l.total_price
                      ) order by l.line_item_gid
                    ) filter (where l.line_item_gid is not null),
                    '[]'::jsonb
                  ) as line_items
           from shopify_orders o
           left join shopify_order_line_items l on l.order_gid = o.order_gid
           left join shopify_customers c on c.customer_gid = o.customer_gid
           where o.shop_domain=$1
           group by o.order_gid, c.display_name
           order by o.created_at desc
           limit $2`,
          [shopDomain, limit],
        ),
        getPool().query<{ count: string }>(
          "select count(*) from shopify_orders where shop_domain=$1",
          [shopDomain],
        ),
      ]);
      return StoreOrdersSchema.parse({
        capturedAt: new Date().toISOString(),
        shopDomain,
        merchantId,
        provenance,
        total: Number(total.rows[0]?.count ?? 0),
        orders: orders.rows.map((row) => ({
          orderGid: row.order_gid,
          name: row.name,
          createdAt: iso(row.created_at),
          financialStatus: row.financial_status,
          fulfillmentStatus: row.fulfillment_status,
          currency: row.currency,
          subtotal: money(row.subtotal),
          total: money(row.total),
          customerGid: row.customer_gid,
          customerName: row.customer_name,
          tags: row.tags ?? [],
          synthetic: Boolean(row.synthetic),
          lineItems: (row.line_items ?? []).map(
            (line: Record<string, unknown>) => ({
              lineItemGid: String(line.lineItemGid),
              title: String(line.title ?? ""),
              quantity: Number(line.quantity ?? 1),
              sku: (line.sku as string | null) ?? null,
              variantGid: (line.variantGid as string | null) ?? null,
              productGid: (line.productGid as string | null) ?? null,
              unitPrice: money(line.unitPrice),
              totalPrice: money(line.totalPrice),
            }),
          ),
        })),
      });
    },

    async customers(shopDomain, limit) {
      const merchantId = await merchantFor(shopDomain);
      if (!merchantId) return undefined;
      const [customers, total] = await Promise.all([
        getPool().query(
          `select customer_gid, display_name, email, created_at, order_count, amount_spent, currency, tags
           from shopify_customers where shop_domain=$1
           order by amount_spent desc, display_name
           limit $2`,
          [shopDomain, limit],
        ),
        getPool().query<{ count: string }>(
          "select count(*) from shopify_customers where shop_domain=$1",
          [shopDomain],
        ),
      ]);
      return StoreCustomersSchema.parse({
        capturedAt: new Date().toISOString(),
        shopDomain,
        merchantId,
        // Fixed by the contract: no granted scope can make this provider-backed.
        provenance: "synthetic_only",
        total: Number(total.rows[0]?.count ?? 0),
        customers: customers.rows.map((row) => ({
          customerGid: row.customer_gid,
          displayName: row.display_name,
          email: row.email,
          createdAt: iso(row.created_at),
          orderCount: Number(row.order_count),
          amountSpent: money(row.amount_spent),
          currency: row.currency,
          tags: row.tags ?? [],
        })),
      });
    },

    async analytics(shopDomain) {
      const merchantId = await merchantFor(shopDomain);
      if (!merchantId) return undefined;
      const [daily, totals, top] = await Promise.all([
        getPool().query(
          `select day, order_count, units, gross_sales, currency
           from shopify_sales_daily where shop_domain=$1 order by day`,
          [shopDomain],
        ),
        getPool().query(
          `select coalesce(sum(order_count),0) as order_count,
                  coalesce(sum(units),0) as units,
                  coalesce(sum(gross_sales),0) as gross_sales,
                  min(currency) as currency
           from shopify_sales_daily where shop_domain=$1`,
          [shopDomain],
        ),
        getPool().query(
          `select l.product_gid, min(l.title) as title,
                  sum(l.quantity) as units, sum(l.total_price) as gross_sales
           from shopify_order_line_items l
           where l.shop_domain=$1
           group by l.product_gid
           order by sum(l.total_price) desc
           limit 10`,
          [shopDomain],
        ),
      ]);
      const summary = totals.rows[0];
      const orderCount = Number(summary?.order_count ?? 0);
      const grossSales = Number(summary?.gross_sales ?? 0);
      return StoreAnalyticsSchema.parse({
        capturedAt: new Date().toISOString(),
        shopDomain,
        merchantId,
        provenance: "synthetic_only",
        currency: summary?.currency ?? "CAD",
        totals: {
          orderCount,
          units: Number(summary?.units ?? 0),
          grossSales: money(grossSales),
          averageOrderValue: money(orderCount ? grossSales / orderCount : 0),
        },
        daily: daily.rows.map((row) => ({
          day: day(row.day),
          orderCount: Number(row.order_count),
          units: Number(row.units),
          grossSales: money(row.gross_sales),
        })),
        topProducts: top.rows.map((row) => ({
          productGid: row.product_gid,
          title: row.title ?? "",
          units: Number(row.units),
          grossSales: money(row.gross_sales),
        })),
      });
    },
  };
}
