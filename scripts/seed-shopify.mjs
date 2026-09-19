// Synthetic catalog seeding is opt-in. --dry requires no credentials or database.
// node scripts/seed-shopify.mjs --store=basegoods-demo --release --dry
// SHOPIFY_SEED_ENABLED=true node --env-file=.env scripts/seed-shopify.mjs --execute --trace-id=seed-1
import {
  connectShopifyRepository,
  seedCatalogProduct,
  ShopifyError,
  ShopifyTransport,
  shopDomain,
} from "../packages/shopify/dist/index.js";
import { catalogFor, roleForStore, releaseCatalogFor } from "./seed-data.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const index = argument.indexOf("=");
    return index === -1
      ? [argument.replace(/^--/, ""), true]
      : [argument.slice(2, index), argument.slice(index + 1)];
  }),
);
let database;
try {
  const stores = args.store
    ? [String(args.store)]
    : (process.env.SHOPIFY_STORES ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  if (!stores.length) throw new ShopifyError("SEED_STORES_REQUIRED");
  if (args.wipe) throw new ShopifyError("SEED_WIPE_NOT_SUPPORTED");
  const execute =
    args.execute === true && process.env.SHOPIFY_SEED_ENABLED === "true";
  if (!args.dry && (!execute || typeof args["trace-id"] !== "string"))
    throw new ShopifyError("SEED_EXECUTION_DISABLED");
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  const budget = args.budget === undefined ? 140 : Number(args.budget);
  if (
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) ||
    !Number.isFinite(budget) ||
    budget < 1 ||
    budget > 3600
  ) {
    throw new ShopifyError("SEED_INVALID_ARGUMENT");
  }
  const started = Date.now();
  for (const store of stores) {
    const domain = shopDomain(
      store.includes(".") ? store : `${store}.myshopify.com`,
    );
    const role =
      typeof args.role === "string"
        ? args.role
        : roleForStore(domain.split(".")[0]);
    const products = (
      args.release ? releaseCatalogFor(role) : catalogFor(role)
    ).slice(0, limit);
    if (!products.length) {
      if (args.release && role === "molecule") {
        console.log(
          JSON.stringify({
            status: "SKIPPED",
            domain,
            reason: "Composite products are created by approved plan execution",
          }),
        );
        continue;
      }
      throw new ShopifyError("SEED_UNKNOWN_ROLE");
    }
    if (args.dry) {
      console.log(
        JSON.stringify({
          status: "DRY_RUN",
          domain,
          role,
          products: products.length,
          variants: products.reduce(
            (sum, product) => sum + product.variants.length,
            0,
          ),
          synthetic: true,
        }),
      );
      continue;
    }
    if (!process.env.DATABASE_URL)
      throw new ShopifyError("SEED_DATABASE_REQUIRED");
    database ??= connectShopifyRepository(
      process.env.DATABASE_URL,
      "shopify-seed",
    );
    const auth = process.env.SHOPIFY_ACCESS_TOKEN
      ? { accessToken: process.env.SHOPIFY_ACCESS_TOKEN }
      : {
          clientId: process.env.SHOPIFY_CLIENT_ID ?? "",
          clientSecret: process.env.SHOPIFY_API_SECRET ?? "",
        };
    const transport = new ShopifyTransport({ domain, auth });
    let created = 0;
    let reused = 0;
    for (const product of products) {
      if (Date.now() - started >= budget * 1000)
        throw new ShopifyError("SEED_BUDGET_REACHED_RERUN_TO_RESUME");
      const result = await seedCatalogProduct({
        transport,
        repository: database.repository,
        product,
        traceId: args["trace-id"],
        executionEnabled: execute,
      });
      if (result.reused) reused++;
      else created++;
    }
    console.log(
      JSON.stringify({
        status: "OK",
        domain,
        created,
        reused,
        synthetic: true,
      }),
    );
  }
} catch (error) {
  console.error(error instanceof ShopifyError ? error.code : "SEED_FAILED");
  process.exitCode = 1;
} finally {
  await database?.close();
}
