import {
  observeCatalogInventory,
  type CatalogInventoryObservation,
} from "@molecule/service-reality";

export type ShopifyInventoryUpdate = CatalogInventoryObservation;

/**
 * Re-ingests a single capacity fact after an authenticated Shopify inventory
 * webhook. The delivery ID-derived trace supplied by the caller makes the
 * causal chain inspectable; the claim itself remains value-deduplicated.
 */
export async function ingestShopifyInventoryUpdate(
  update: ShopifyInventoryUpdate,
  observe: typeof observeCatalogInventory = observeCatalogInventory,
) {
  return observe(update);
}
