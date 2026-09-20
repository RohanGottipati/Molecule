import { randomUUID } from "node:crypto";

import {
  extractCapacityClaims,
  merchantIdForShopifyStore,
  type ShopifyRealityClaimInput,
} from "@molecule/shopify";
import type { ShopifySnapshot } from "@molecule/shopify/catalog";
import { ingestClaim, type RawClaimInput } from "@molecule/service-reality";

export interface ShopifySnapshotSource {
  getSnapshot(shop: string): Promise<ShopifySnapshot>;
}

export interface ShopifyCapacityIngestionResult {
  traceId: string;
  accepted: number;
  quarantined: number;
  claimIds: string[];
  skippedStores: string[];
}

export interface ShopifyCapacityIngestionOptions {
  traceId?: string;
  ingest?: (
    input: RawClaimInput,
    traceId: string,
  ) => ReturnType<typeof ingestClaim>;
  onSkippedStore?: (store: string) => void;
}

export interface ShopifyInventoryUpdate {
  shop: string;
  inventoryItemId: string | number;
  locationId?: string | number;
  available: number;
  observedAt?: string;
  traceId: string;
}

export type ShopifyInventoryIngestionResult =
  | { status: "skipped"; shop: string }
  | {
      status: "accepted";
      claimId: string;
      merchantId: string;
      traceId: string;
    }
  | {
      status: "quarantined";
      merchantId: string;
      reason: string;
      traceId: string;
    };

function inventorySourceReference(inventoryItemId: string | number): string {
  const value = String(inventoryItemId).trim();
  return value.startsWith("gid://")
    ? value
    : `gid://shopify/InventoryItem/${value}`;
}

/**
 * Converts Shopify's normalized inventory webhook fields into the same
 * capacity claim shape as a catalog snapshot. Shopify sends an inventory item
 * ID rather than the product title, so the evidence deliberately identifies
 * the exact item and location instead of inventing product metadata.
 */
export function extractInventoryCapacityClaim(
  update: Omit<ShopifyInventoryUpdate, "traceId">,
  merchantId: string,
): ShopifyRealityClaimInput {
  const itemId = String(update.inventoryItemId).trim();
  const location =
    update.locationId === undefined ? "" : ` at location ${update.locationId}`;
  return {
    merchantId,
    field: "capacity_per_day",
    rawValue: update.available,
    sourceKind: "shopify",
    sourceReference: inventorySourceReference(update.inventoryItemId),
    ...(update.observedAt ? { observedAt: update.observedAt } : {}),
    sourceAuthority: 0.9,
    extractionConfidence: 1,
    evidenceText: `Inventory item ${itemId}${location} tracked inventory = ${update.available}`,
  };
}

/**
 * Re-ingests a single capacity fact after an authenticated Shopify inventory
 * webhook. The delivery ID-derived trace supplied by the caller makes the
 * causal chain inspectable; the claim itself remains value-deduplicated.
 */
export async function ingestShopifyInventoryUpdate(
  update: ShopifyInventoryUpdate,
  options: Pick<ShopifyCapacityIngestionOptions, "ingest"> = {},
): Promise<ShopifyInventoryIngestionResult> {
  const merchantId = merchantIdForShopifyStore(update.shop);
  if (!merchantId) return { status: "skipped", shop: update.shop };
  const ingest = options.ingest ?? ingestClaim;
  const ingested = await ingest(
    extractInventoryCapacityClaim(update, merchantId),
    update.traceId,
  );
  if (ingested.ok) {
    return {
      status: "accepted",
      claimId: ingested.claim.claimId,
      merchantId,
      traceId: update.traceId,
    };
  }
  return {
    status: "quarantined",
    merchantId,
    reason: ingested.reason,
    traceId: update.traceId,
  };
}

/**
 * Ingests known merchant capacity snapshots through Reality's canonical
 * boundary. The same trace ID identifies one startup/batch run; Reality's
 * artifact checksum makes duplicate snapshots safe to replay.
 */
export async function ingestShopifyCapacityBatch(
  source: ShopifySnapshotSource,
  stores: readonly string[],
  options: ShopifyCapacityIngestionOptions = {},
): Promise<ShopifyCapacityIngestionResult> {
  const traceId = options.traceId ?? randomUUID();
  const ingest = options.ingest ?? ingestClaim;
  const result: ShopifyCapacityIngestionResult = {
    traceId,
    accepted: 0,
    quarantined: 0,
    claimIds: [],
    skippedStores: [],
  };

  for (const store of stores) {
    const merchantId = merchantIdForShopifyStore(store);
    if (!merchantId) {
      result.skippedStores.push(store);
      options.onSkippedStore?.(store);
      continue;
    }
    const snapshot = await source.getSnapshot(store);
    const claims: ShopifyRealityClaimInput[] = extractCapacityClaims(
      snapshot,
      merchantId,
    );
    for (const claim of claims) {
      const ingested = await ingest(claim, traceId);
      if (ingested.ok) {
        result.accepted += 1;
        result.claimIds.push(ingested.claim.claimId);
      } else {
        result.quarantined += 1;
      }
    }
  }
  return result;
}
