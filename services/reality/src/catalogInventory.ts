import { createHash } from "node:crypto";
import { effectId, persistEvent, transaction } from "@molecule/db";
import { ingestClaim, resolveMerchant } from "./repository.js";

export interface CatalogInventoryObservation {
  shop: string;
  inventoryItemId: string | number;
  locationId?: string | number;
  available: number;
  observedAt?: string;
  traceId: string;
}
const gid = (kind: string, id: string | number) => String(id).startsWith("gid://") ? String(id) : `gid://shopify/${kind}/${id}`;

/** Batch inventory reads and signed webhooks must call this same exact-location boundary. */
export async function observeCatalogInventory(input: CatalogInventoryObservation): Promise<{ status: "unmapped" | "stale" | "unchanged" | "changed"; resourceId?: string; merchantId?: string }> {
  if (!input.traceId.trim() || !Number.isFinite(input.available)) throw new Error("INVALID_INVENTORY_OBSERVATION");
  if (input.locationId === undefined || !input.observedAt) return { status: "unmapped" };
  if (!Number.isFinite(Date.parse(input.observedAt)) || Date.parse(input.observedAt) > Date.now() + 60_000) throw new Error("INVALID_OBSERVATION_TIME");
  const shop = input.shop.toLowerCase().replace(/\.myshopify\.com$/, "") + ".myshopify.com";
  const item = gid("InventoryItem", input.inventoryItemId);
  const location = gid("Location", input.locationId);
  const source = `${shop}/${item}/${location}`;
  return transaction(async client => {
    const mapping = await client.query<{ resource_id: string; merchant_id: string; kind: string; available: string; observed_at: Date; status: string }>(`
      select s.* from catalog_active_version a
      join catalog_records r on r.catalog_version=a.catalog_version and r.record_type='resource'
      join merchant_stores m on m.merchant_id=r.record_json->>'merchantId'
      join catalog_resource_state s on s.resource_id=r.record_id
      where m.shopify_domain=$1 and r.record_json->>'inventoryItemGid'=$2 and r.record_json->>'locationGid'=$3
      for update of s`, [shop, item, location]);
    if (!mapping.rowCount) return { status: "unmapped" };
    if (mapping.rowCount !== 1) throw new Error("AMBIGUOUS_INVENTORY_RESOURCE");
    const resource = mapping.rows[0]!;
    const ids = { resourceId: resource.resource_id, merchantId: resource.merchant_id };
    const observedAt = new Date(input.observedAt!);
    if (observedAt < resource.observed_at) return { status: "stale", ...ids };
    const available = Math.max(0, input.available);
    if (observedAt.getTime() === resource.observed_at.getTime() && Number(resource.available) === available) return { status: "unchanged", ...ids };
    const status = observedAt.getTime() === resource.observed_at.getTime() ? "conflicted" : "known";
    const observationKey = createHash("sha256").update(JSON.stringify([source, input.observedAt, available, status])).digest("hex");
    await client.query("update catalog_resource_state set available=$2,observed_at=$3,source_reference=$4,status=$5 where resource_id=$1", [resource.resource_id, available, observedAt, source, status]);
    await ingestClaim({ merchantId: resource.merchant_id, field: `resource.${resource.resource_id}.${resource.kind === "inventory" ? "inventory" : "capacity"}`,
      rawValue: available, sourceKind: "shopify", sourceReference: source, observedAt: observedAt.toISOString(), sourceAuthority: 0.9, extractionConfidence: 1,
      evidenceText: `Exact-location Shopify availability ${input.available}; resource ${resource.resource_id}` }, input.traceId, client);
    await resolveMerchant(resource.merchant_id, input.traceId, client);
    const changed = status !== resource.status || available !== Number(resource.available);
    if (changed) {
      await client.query(`insert into catalog_recovery_requests(order_id,resource_id,observation_key)
        select order_id,$1,$2 from order_sessions s
        where s.session_json->>'state' in ('PLAN_VALIDATED','AWAITING_APPROVAL','COMPLETED','NEEDS_HUMAN') and exists (
          select 1 from jsonb_array_elements(coalesce(s.session_json->'activePlan'->'nodes','[]')) n
          cross join lateral jsonb_array_elements(coalesce(n->'resourceRefs','[]')) ref where ref->>'resourceId'=$1)
        on conflict(order_id,resource_id) do update set observation_key=excluded.observation_key,status='pending',updated_at=now()`, [resource.resource_id, observationKey]);
    }
    await persistEvent({ eventId: effectId(`catalog-observation:${observationKey}`), traceId: input.traceId, merchantId: resource.merchant_id, eventType: changed ? "catalog.resource.changed" : "catalog.resource.observed", source: "shopify", severity: status === "conflicted" ? "WARN" : "INFO", ts: new Date().toISOString(), payload: { ...ids, observationKey, available, status, sourceReference: source, observedAt: input.observedAt } }, client);
    return { status: changed ? "changed" : "unchanged", ...ids };
  });
}
