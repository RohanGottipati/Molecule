import { z } from "zod";
import { roleForStore } from "@molecule/test-fixtures";

import {
  ShopifySnapshotSchema,
  type ShopifySnapshot,
} from "./catalog/types.js";
import { ShopifyError } from "./types.js";

export const SHOPIFY_API_VERSION = "2026-07";
export type ShopifyAuth =
  { accessToken: string } | { clientId: string; clientSecret: string };

export interface ShopifyTransportOptions {
  domain: string;
  auth: ShopifyAuth;
  timeoutMs?: number;
  maxThrottleRetries?: number;
  fetch?: typeof globalThis.fetch;
}

export function shopDomain(input: string): string {
  const domain = input.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(domain)) {
    throw new ShopifyError("INVALID_SHOP_DOMAIN");
  }
  return domain;
}

export function checkoutUrl(
  input: string,
  domain: string,
  extraHosts: string[] = [],
): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ShopifyError("UNSAFE_CHECKOUT_URL", true);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![domain, ...extraHosts].includes(url.hostname)
  )
    throw new ShopifyError("UNSAFE_CHECKOUT_URL", true);
  return url.toString();
}

export function adminUrl(
  domain: string,
  kind: "products" | "draft_orders",
  gid: string,
): string {
  const pattern =
    kind === "products"
      ? /^gid:\/\/shopify\/Product\/\d+$/
      : /^gid:\/\/shopify\/DraftOrder\/\d+$/;
  if (!pattern.test(gid)) throw new ShopifyError("INVALID_PROVIDER_ID", true);
  const id = gid.split("/").at(-1);
  if (!id || !/^\d+$/.test(id))
    throw new ShopifyError("INVALID_PROVIDER_ID", true);
  return `https://${shopDomain(domain)}/admin/${kind}/${id}`;
}

const EnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        extensions: z.object({ code: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

const VariantConnectionSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), sku: z.string().nullable(), price: z.string(),
    selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })).optional().default([]),
    inventoryItem: z.object({ id: z.string(), tracked: z.boolean() }).nullable().optional() })),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});

export class ShopifyTransport {
  readonly domain: string;
  private readonly options: ShopifyTransportOptions;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  private readonly timeoutMs: number;
  private readonly maxThrottleRetries: number;

  constructor(options: ShopifyTransportOptions) {
    this.domain = shopDomain(options.domain);
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxThrottleRetries = options.maxThrottleRetries ?? 2;
    if (
      this.timeoutMs < 1 ||
      this.timeoutMs > 60_000 ||
      !Number.isFinite(this.timeoutMs) ||
      !Number.isInteger(this.maxThrottleRetries) ||
      this.maxThrottleRetries < 0 ||
      this.maxThrottleRetries > 3 ||
      ("accessToken" in options.auth
        ? !options.auth.accessToken.trim()
        : !options.auth.clientId.trim() || !options.auth.clientSecret.trim())
    )
      throw new ShopifyError("INVALID_TRANSPORT_CONFIG");
  }

  private async request(
    path: string,
    init: RequestInit,
    mutation: boolean,
  ): Promise<{ response: Response; body: unknown }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ShopifyError("TIMEOUT", mutation));
        }, this.timeoutMs);
      });
      const operation = async () => {
        const response = await (this.options.fetch ?? globalThis.fetch)(
          `https://${this.domain}${path}`,
          { ...init, redirect: "error", signal: controller.signal },
        );
        let body: unknown;
        if (response.ok) {
          try {
            body = await response.json();
          } catch {
            throw new ShopifyError("INVALID_RESPONSE", mutation);
          }
        }
        return { response, body };
      };
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      throw error instanceof ShopifyError
        ? error
        : new ShopifyError("NETWORK_ERROR", mutation);
    } finally {
      clearTimeout(timer);
    }
  }

  private async accessToken(): Promise<string> {
    if ("accessToken" in this.options.auth)
      return this.options.auth.accessToken;
    if (this.token && this.token.expiresAt > Date.now() + 60_000)
      return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    const auth = this.options.auth;
    this.tokenRequest = (async () => {
      const { response, body } = await this.request(
        "/admin/oauth/access_token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: auth.clientId,
            client_secret: auth.clientSecret,
          }),
        },
        false,
      );
      if (!response.ok) throw new ShopifyError(`AUTH_HTTP_${response.status}`);
      const result = z
        .object({
          access_token: z.string().min(1),
          expires_in: z.number().int().positive(),
        })
        .safeParse(body);
      if (!result.success) throw new ShopifyError("AUTH_INVALID_RESPONSE");
      this.token = {
        value: result.data.access_token,
        expiresAt: Date.now() + result.data.expires_in * 1000,
      };
      return this.token.value;
    })();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = undefined;
    }
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    mutation = false,
  ): Promise<T> {
    const token = await this.accessToken();
    for (let attempt = 0; ; attempt++) {
      const { response, body } = await this.request(
        `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-shopify-access-token": token,
          },
          body: JSON.stringify({ query, variables }),
        },
        mutation,
      );
      const parsed = EnvelopeSchema.safeParse(body);
      const throttled =
        response.status === 429 ||
        (parsed.success &&
          parsed.data.data == null &&
          !!parsed.data.errors?.length &&
          parsed.data.errors.every(
            (error) => error.extensions?.code === "THROTTLED",
          ));
      if (throttled) {
        const retryAfter = response.headers.get("retry-after");
        const delay =
          retryAfter === null ? 100 * 2 ** attempt : Number(retryAfter) * 1000;
        if (
          attempt >= this.maxThrottleRetries ||
          !Number.isFinite(delay) ||
          delay < 0 ||
          delay > 2_000
        ) {
          throw new ShopifyError("THROTTLED");
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (response.status === 401 && this.token?.value === token)
        this.token = undefined;
      if (!response.ok)
        throw new ShopifyError(
          `HTTP_${response.status}`,
          mutation && (response.status >= 500 || response.status === 408),
        );
      const version = response.headers.get("x-shopify-api-version");
      if (version && version !== SHOPIFY_API_VERSION)
        throw new ShopifyError("API_VERSION_MISMATCH", mutation);
      if (!parsed.success) throw new ShopifyError("INVALID_RESPONSE", mutation);
      if (parsed.data.errors?.length)
        throw new ShopifyError("GRAPHQL_ERROR", mutation);
      const data = schema.safeParse(parsed.data.data);
      if (!data.success) throw new ShopifyError("INVALID_RESPONSE", mutation);
      return data.data;
    }
  }

  async verifyStore() {
    return this.graphql(
      `query VerifyStore { shop { name myshopifyDomain currencyCode }
       currentAppInstallation { accessScopes { handle } } }`,
      {},
      z.object({
        shop: z.object({
          name: z.string(),
          myshopifyDomain: z.string(),
          currencyCode: z.string(),
        }),
        currentAppInstallation: z.object({
          accessScopes: z.array(z.object({ handle: z.string() })),
        }),
      }),
    );
  }

  async listProducts(after?: string) {
    return this.graphql(
      `query Products($after: String) { products(first: 100, after: $after) {
       nodes { id title handle status vendor productType tags variants(first: 100) { nodes { id sku price selectedOptions { name value } inventoryItem { id tracked } }
       pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }`,
      { after: after ?? null },
      z.object({
        products: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              handle: z.string(),
              status: z.string(),
              vendor: z.string().optional().default(""),
              productType: z.string().optional().default(""),
              tags: z.array(z.string()).optional().default([]),
              variants: VariantConnectionSchema,
            }),
          ),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
        }),
      }),
    );
  }

  async listProductVariants(productId: string, after: string) {
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) throw new ShopifyError("INVALID_PRODUCT_ID");
    return this.graphql(`query Variants($id: ID!, $after: String!) {
      product(id: $id) { variants(first:100, after:$after) { nodes { id sku price selectedOptions { name value } inventoryItem { id tracked } } pageInfo { hasNextPage endCursor } } }
    }`, { id: productId, after }, z.object({ product: z.object({ variants: VariantConnectionSchema }).nullable() }));
  }

  /**
   * Reads all tagged capacity products into the shared snapshot shape. It
   * refuses partial product, variant, or inventory-location pages rather than
   * turning incomplete Shopify data into an operational claim.
   */
  async getSnapshot(shop = this.domain): Promise<ShopifySnapshot> {
    const products: ShopifySnapshot["products"] = [];
    const capacity: ShopifySnapshot["capacity"] = [];
    let after: string | undefined;
    const productCursors = new Set<string>();

    do {
      const page = await this.listProducts(after);
      for (const product of page.products.nodes) {
        const cursors = new Set<string>();
        while (product.variants.pageInfo.hasNextPage) {
          const cursor = product.variants.pageInfo.endCursor;
          if (!cursor || cursors.has(cursor)) throw new ShopifyError("CATALOG_PAGINATION_REQUIRED");
          cursors.add(cursor);
          const next = await this.listProductVariants(product.id, cursor);
          if (!next.product) throw new ShopifyError("CATALOG_PRODUCT_DISAPPEARED");
          product.variants.nodes.push(...next.product.variants.nodes);
          product.variants.pageInfo = next.product.variants.pageInfo;
        }
        products.push({
          productId: product.id,
          handle: product.handle,
          title: product.title,
          vendor: product.vendor,
          productType: product.productType,
          tags: product.tags,
          variants: product.variants.nodes.map((variant) => ({
            variantId: variant.id,
            sku: variant.sku ?? "",
            optionValues: Object.fromEntries(
              variant.selectedOptions.map(({ name, value }) => [name, value]),
            ),
            price: variant.price,
            tracked: variant.inventoryItem?.tracked ?? false,
            quantity: null,
          })),
        });
        if (!product.tags.includes("capacity")) continue;
        for (const variant of product.variants.nodes) {
          if (!variant.inventoryItem?.tracked) continue;
          const inventory = await this.getInventory(variant.inventoryItem.id);
          const item = inventory.inventoryItem;
          if (!item) continue;
          if (item.inventoryLevels.pageInfo.hasNextPage)
            throw new ShopifyError("CATALOG_PAGINATION_REQUIRED");
          const quantity = item.inventoryLevels.nodes.reduce(
            (total, level) =>
              total +
              (level.quantities.find(({ name }) => name === "available")
                ?.quantity ?? 0),
            0,
          );
          capacity.push({
            shop,
            role: roleForStore(shop),
            itemId: item.id,
            title: product.title,
            quantity,
          });
        }
      }
      if (!page.products.pageInfo.hasNextPage) break;
      after = page.products.pageInfo.endCursor ?? undefined;
      if (!after || productCursors.has(after)) throw new ShopifyError("CATALOG_PAGINATION_REQUIRED");
      productCursors.add(after);
    } while (after);

    return ShopifySnapshotSchema.parse({
      shop,
      role: roleForStore(shop),
      capturedAt: new Date().toISOString(),
      capacity,
      products,
    });
  }

  async getInventory(inventoryItemId: string) {
    const result = await this.inventoryPage(inventoryItemId);
    if (!result.inventoryItem) return result;
    const levels = result.inventoryItem.inventoryLevels;
    const cursors = new Set<string>();
    while (levels.pageInfo.hasNextPage) {
      const cursor = levels.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) throw new ShopifyError("CATALOG_PAGINATION_REQUIRED");
      cursors.add(cursor);
      const next = await this.inventoryPage(inventoryItemId, cursor);
      if (!next.inventoryItem) throw new ShopifyError("CATALOG_INVENTORY_DISAPPEARED");
      levels.nodes.push(...next.inventoryItem.inventoryLevels.nodes);
      levels.pageInfo = next.inventoryItem.inventoryLevels.pageInfo;
    }
    return result;
  }

  private async inventoryPage(inventoryItemId: string, after?: string) {
    if (!/^gid:\/\/shopify\/InventoryItem\/\d+$/.test(inventoryItemId))
      throw new ShopifyError("INVALID_INVENTORY_ID");
    return this.graphql(
      `query Inventory($id: ID!, $after: String) { inventoryItem(id: $id) { id tracked inventoryLevels(first: 100, after: $after) {
       nodes { updatedAt location { id name } quantities(names: ["available"]) { name quantity } }
       pageInfo { hasNextPage endCursor } } } }`,
      { id: inventoryItemId, after: after ?? null },
      z.object({
        inventoryItem: z
          .object({
            id: z.string(),
            tracked: z.boolean(),
            inventoryLevels: z.object({
              nodes: z.array(
                z.object({
                  updatedAt: z.iso.datetime().optional(),
                  location: z.object({ id: z.string(), name: z.string() }),
                  quantities: z.array(
                    z.object({ name: z.string(), quantity: z.number().int() }),
                  ),
                }),
              ),
              pageInfo: z.object({
                hasNextPage: z.boolean(),
                endCursor: z.string().nullable(),
              }),
            }),
          })
          .nullable(),
      }),
    );
  }
}
