// Read-only verification. Build @molecule/shopify first; never prints tokens or raw errors.
import {
  ShopifyError,
  ShopifyTransport,
  shopDomain,
} from "../packages/shopify/dist/index.js";

const stores = (process.env.SHOPIFY_STORES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
let failed = 0;
if (!stores.length) {
  console.error("Missing SHOPIFY_STORES");
  process.exitCode = 1;
}
for (const store of stores) {
  try {
    const domain = shopDomain(
      store.includes(".") ? store : `${store}.myshopify.com`,
    );
    const auth = process.env.SHOPIFY_ACCESS_TOKEN
      ? { accessToken: process.env.SHOPIFY_ACCESS_TOKEN }
      : {
          clientId: process.env.SHOPIFY_CLIENT_ID ?? "",
          clientSecret: process.env.SHOPIFY_API_SECRET ?? "",
        };
    const { shop, currentAppInstallation } = await new ShopifyTransport({
      domain,
      auth,
    }).verifyStore();
    console.log(
      JSON.stringify({
        status: "OK",
        domain: shop.myshopifyDomain,
        name: shop.name,
        currency: shop.currencyCode,
        scopes: currentAppInstallation.accessScopes.map(
          (scope) => scope.handle,
        ),
      }),
    );
  } catch (error) {
    failed++;
    console.error(
      `FAIL ${error instanceof ShopifyError ? error.code : "VERIFICATION_FAILED"}`,
    );
  }
}
if (failed) process.exitCode = 1;
