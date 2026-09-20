import { MERCHANT_IDS, roleForStore } from "@molecule/test-fixtures";

const INGESTIBLE_ROLES = new Set([
  "basegoods",
  "stitchworks",
  "threadforge",
  "needlenorth",
  "laserlab",
  "packship",
  "snackbox",
]);

/**
 * Maps a configured Shopify store to a seeded Tiger merchant. A store may
 * legitimately have no Tiger merchant (for example PrintPress or Molecule's
 * central storefront), in which case it must be skipped rather than guessed.
 */
export function merchantIdForShopifyStore(
  storeHandle: string,
): string | undefined {
  const handle = storeHandle
    .trim()
    .toLowerCase()
    .replace(/\.myshopify\.com$/, "");
  const role = roleForStore(handle);
  if (!INGESTIBLE_ROLES.has(role)) return undefined;
  return MERCHANT_IDS[role as keyof typeof MERCHANT_IDS];
}
