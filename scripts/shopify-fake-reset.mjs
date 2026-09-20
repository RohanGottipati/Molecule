// Clears the fake Shopify mutation overlay, returning the synthetic stores to their
// deterministic seed. Affects local synthetic data only; it can never touch a real store.
//   node scripts/shopify-fake-reset.mjs
import { PersistentFakeShopifyAdmin } from "../packages/shopify/dist/fake/index.js";
import { storeHandles } from "./lib/molecule-env.mjs";

process.env.SHOPIFY_MODE = "fake";
const stores = storeHandles();
const admin = new PersistentFakeShopifyAdmin(
  stores.length ? { stores } : undefined,
);
admin.reset();
console.log(
  JSON.stringify({
    status: "OK",
    stores: admin.listStores().length,
    synthetic: true,
  }),
);
