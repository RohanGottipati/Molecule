import { MERCHANT_IDS, roleForStore } from "@molecule/test-fixtures";

import type { ShopifySnapshot } from "./catalog/types.js";

/**
 * The subset of Reality's ingestion envelope produced from Shopify inventory.
 *
 * This stays structural on purpose: Shopify remains independent from the
 * Reality service package, while the orchestrator can pass these values
 * directly to Reality's `ingestClaim` boundary.
 */
export interface ShopifyRealityClaimInput {
  merchantId: string;
  field: string;
  rawValue: unknown;
  sourceKind: "shopify";
  sourceReference: string;
  observedAt: string;
  sourceAuthority: number;
  extractionConfidence: number;
  evidenceText: string;
}

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
  const role = roleForStore(storeHandle);
  if (!INGESTIBLE_ROLES.has(role)) return undefined;
  return MERCHANT_IDS[role as keyof typeof MERCHANT_IDS];
}

/**
 * Converts Shopify's tracked capacity items into provenance-preserving Reality
 * claims. This is intentionally pure: it performs no network or database work.
 */
export function extractCapacityClaims(
  snapshot: ShopifySnapshot,
  merchantId: string,
): ShopifyRealityClaimInput[] {
  return snapshot.capacity.map((item) => ({
    merchantId,
    field: "capacity_per_day",
    rawValue: item.quantity,
    sourceKind: "shopify",
    sourceReference: item.itemId,
    observedAt: snapshot.capturedAt,
    sourceAuthority: 0.9,
    extractionConfidence: 1,
    evidenceText: `${item.title} tracked inventory = ${item.quantity}`,
  }));
}
