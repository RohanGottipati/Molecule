// Shared demo fixtures: the same seed catalogs used to populate the real dev stores
// (scripts/seed-shopify.mjs) and the store handles from the current Dev Dashboard org.
// See docs/TASKS/SHOPIFY_LOOP.md section 1 for what these stores are.
export { catalogFor, roleForStore, slug } from "./seed-data.mjs";

export const DEMO_STORE_HANDLES = [
  "molecule-storefront",
  "stitchworks-7gw6fagb",
  "threadforge-eznglsyk",
  "basegoods-tyefhh8o",
  "laserlab-yprjwhc5",
  "packship-5lfaj5qq",
  "snackbox-0hubj57j",
  "printpress-b9oy1d5n",
] as const;
