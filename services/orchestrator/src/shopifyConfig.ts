import { z } from "zod";
import {
  merchantIdForShopifyStore,
  shopDomain,
  type ShopifyAuth,
  type ShopifyTransportOptions,
} from "@molecule/shopify";
import type { Config } from "./config.js";

const AuthSchema = z.union([
  z.object({ accessToken: z.string().trim().min(1) }).strict(),
  z
    .object({
      clientId: z.string().trim().min(1),
      clientSecret: z.string().trim().min(1),
    })
    .strict(),
]);
const SuppliersSchema = z.record(
  z.string().min(1),
  z.object({ domain: z.string().min(1), auth: AuthSchema.optional() }).strict(),
);

export function configuredShopifyDomains(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map(domain),
    ),
  ];
}

function domain(value: string): string {
  const normalized = value.trim().toLowerCase();
  return shopDomain(
    normalized.endsWith(".myshopify.com")
      ? normalized
      : `${normalized}.myshopify.com`,
  );
}

/** Resolve credentials once, before startup can perform database/provider work. */
export function liveShopifyConfiguration(config: Config): {
  centralStore: ShopifyTransportOptions;
  supplierStores: Record<string, ShopifyTransportOptions>;
  snapshotStores: string[];
} {
  try {
    return resolveLiveShopifyConfiguration(config);
  } catch {
    // Zod/JSON errors can contain credential-bearing input. Never expose them.
    throw new Error(
      "Invalid live Shopify configuration: check store domains, unique merchant mappings and server-side credentials",
    );
  }
}

function resolveLiveShopifyConfiguration(config: Config) {
  const snapshotStores = configuredShopifyDomains(config.SHOPIFY_STORES);
  const storefront =
    config.SHOPIFY_STOREFRONT_DOMAIN ?? config.MOLECULE_STOREFRONT_DOMAIN;
  if (!storefront || !snapshotStores.length) throw new Error("Missing stores");
  const centralDomain = domain(storefront);
  if (
    config.SHOPIFY_STOREFRONT_DOMAIN &&
    config.MOLECULE_STOREFRONT_DOMAIN &&
    domain(config.SHOPIFY_STOREFRONT_DOMAIN) !==
      domain(config.MOLECULE_STOREFRONT_DOMAIN)
  )
    throw new Error("Conflicting storefronts");

  const sharedAuth: ShopifyAuth | undefined =
    config.SHOPIFY_CLIENT_ID && config.SHOPIFY_API_SECRET
      ? AuthSchema.parse({
          clientId: config.SHOPIFY_CLIENT_ID,
          clientSecret: config.SHOPIFY_API_SECRET,
        })
      : undefined;
  const centralAuth = config.SHOPIFY_ACCESS_TOKEN
    ? AuthSchema.parse({ accessToken: config.SHOPIFY_ACCESS_TOKEN })
    : sharedAuth;
  if (!centralAuth) throw new Error("Missing storefront credentials");

  const explicit = config.SHOPIFY_SUPPLIER_STORES
    ? SuppliersSchema.parse(JSON.parse(config.SHOPIFY_SUPPLIER_STORES))
    : {};
  const supplierStores: Record<string, ShopifyTransportOptions> = {};
  const domainOwners = new Map<string, string>();
  for (const [merchantId, supplier] of Object.entries(explicit)) {
    const supplierDomain = domain(supplier.domain);
    const auth = supplier.auth ?? sharedAuth;
    if (
      !auth ||
      supplierDomain === centralDomain ||
      domainOwners.has(supplierDomain)
    )
      throw new Error("Missing credentials or ambiguous supplier domain");
    supplierStores[merchantId] = { domain: supplierDomain, auth };
    domainOwners.set(supplierDomain, merchantId);
  }
  for (const supplierDomain of snapshotStores) {
    if (supplierDomain === centralDomain) continue;
    const merchantId = merchantIdForShopifyStore(supplierDomain);
    // Unknown merchants remain unmapped; never invent operational identities.
    if (!merchantId) continue;
    const configured = supplierStores[merchantId];
    if (configured) {
      if (configured.domain !== supplierDomain)
        throw new Error("Conflicting supplier domains");
      continue;
    }
    if (!sharedAuth || domainOwners.has(supplierDomain))
      throw new Error(
        "Missing supplier credentials or conflicting merchant mapping",
      );
    supplierStores[merchantId] = { domain: supplierDomain, auth: sharedAuth };
    domainOwners.set(supplierDomain, merchantId);
  }
  if (!Object.keys(supplierStores).length)
    throw new Error("No supplier stores");
  return {
    centralStore: { domain: centralDomain, auth: centralAuth },
    supplierStores,
    snapshotStores,
  };
}
