import { effectId, getPool, persistEvent, transaction } from "@molecule/db";
import { observeCatalogInventory } from "@molecule/service-reality";
import type { ShopifyTransport } from "@molecule/shopify";

/** Same exact-location IDs, provider observation time and resolver as webhooks. */
export async function syncCatalogInventory(
  transportFor: (
    domain: string,
  ) => Pick<ShopifyTransport, "getInventory"> | undefined,
  traceId: string,
): Promise<{ observed: number; unavailable: string[] }> {
  const mappings = await getPool().query<{
    resource_id: string;
    domain: string;
    item: string;
    location: string;
  }>(`
    select r.record_id resource_id,m.shopify_domain domain,r.record_json->>'inventoryItemGid' item,r.record_json->>'locationGid' location
    from catalog_active_version a join catalog_records r on r.catalog_version=a.catalog_version and r.record_type='resource'
    join merchant_stores m on m.merchant_id=r.record_json->>'merchantId'
    where r.record_json ? 'inventoryItemGid' order by domain,item,location`);
  let observed = 0;
  const unavailable: string[] = [];
  const snapshots = new Map<
    string,
    Awaited<ReturnType<ShopifyTransport["getInventory"]>>
  >();
  for (const mapping of mappings.rows) {
    const key = `${mapping.domain}/${mapping.item}`;
    let snapshot = snapshots.get(key);
    if (!snapshot) {
      const transport = transportFor(mapping.domain);
      if (!transport) {
        unavailable.push(mapping.resource_id);
        continue;
      }
      snapshot = await transport.getInventory(mapping.item);
      snapshots.set(key, snapshot);
    }
    const level = snapshot.inventoryItem?.inventoryLevels.nodes.find(
      (row) => row.location.id === mapping.location,
    );
    const available = level?.quantities.find(
      (q) => q.name === "available",
    )?.quantity;
    if (
      !snapshot.inventoryItem?.tracked ||
      !level?.updatedAt ||
      available === undefined
    ) {
      // A missing/inactive location cannot preserve executable stock from an old snapshot.
      unavailable.push(mapping.resource_id);
      await transaction(async (client) => {
        const changed = await client.query(
          "update catalog_resource_state set status='unknown' where resource_id=$1 and status<>'unknown' returning merchant_id",
          [mapping.resource_id],
        );
        if (!changed.rowCount) return;
        const key = `${traceId}:${mapping.resource_id}:unavailable`;
        await client.query(
          `insert into catalog_recovery_requests(order_id,resource_id,observation_key)
          select order_id,$1,$2 from order_sessions s where exists (
            select 1 from jsonb_array_elements(coalesce(s.session_json->'activePlan'->'nodes','[]')) n
            cross join lateral jsonb_array_elements(coalesce(n->'resourceRefs','[]')) ref where ref->>'resourceId'=$1)
          on conflict(order_id,resource_id) do update set observation_key=excluded.observation_key,status='pending',updated_at=now()`,
          [mapping.resource_id, key],
        );
        await persistEvent(
          {
            eventId: effectId(key),
            traceId,
            merchantId: changed.rows[0].merchant_id,
            eventType: "catalog.resource.unavailable",
            source: "shopify",
            severity: "WARN",
            ts: new Date().toISOString(),
            payload: {
              resourceId: mapping.resource_id,
              reason: "missing_tracked_location_or_observation",
            },
          },
          client,
        );
      });
      continue;
    }
    await observeCatalogInventory({
      shop: mapping.domain,
      inventoryItemId: mapping.item,
      locationId: mapping.location,
      available,
      observedAt: level.updatedAt,
      traceId,
    });
    observed++;
  }
  return { observed, unavailable };
}
