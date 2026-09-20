import {
  CatalogRecordSchema,
  ProductionPlanSchema,
  type ProductionPlan,
} from "@molecule/contracts";
import { transaction } from "./client.js";
import { effectId, persistEvent } from "./operations.js";

/** Reserve the whole graph atomically using exactly the solver's resource identities. */
export async function reserveCatalogPlan(
  input: ProductionPlan,
  traceId: string,
  actionKey: string,
): Promise<string[]> {
  const plan = ProductionPlanSchema.parse(input);
  if (
    !traceId.trim() ||
    !actionKey.trim() ||
    plan.status !== "VALID" ||
    !plan.nodes.length
  )
    throw new Error("INVALID_RESERVATION_REQUEST");
  return transaction(async (client) => {
    const active = await client.query<{ catalog_version: string }>(
      "select catalog_version from catalog_active_version",
    );
    const nodes = [...plan.nodes].sort((a, b) =>
      a.nodeId.localeCompare(b.nodeId),
    );
    const activeVersion = active.rows[0]?.catalog_version;
    for (const node of nodes) {
      if (
        !node.catalogVersion ||
        !node.selectedItem ||
        !node.resourceRefs?.length
      )
        throw new Error("MISSING_CATALOG_REFERENCES");
      if (node.catalogVersion !== activeVersion)
        throw new Error("STALE_CATALOG_VERSION");
    }
    const selectedIds = nodes.flatMap(({ selectedItem }) => [
      selectedItem!.bindingId,
      selectedItem!.variantId,
      selectedItem!.productId,
    ]);
    const selected = await client.query<{ record_json: unknown }>(
      `select record_json from catalog_records
      where catalog_version=$1 and (
        record_id=any($2::text[]) or record_id in (
          select record_json->>'familyId' from catalog_records
          where catalog_version=$1 and record_id=any($2::text[])
        )
      )`,
      [activeVersion, selectedIds],
    );
    const catalogRecords = new Map(
      selected.rows.map((row) => {
        const record = CatalogRecordSchema.parse(row.record_json);
        return [record.id, record] as const;
      }),
    );
    const keys: string[] = [];
    for (const node of nodes) {
      const selectedItem = node.selectedItem!;
      const resourceRefs = node.resourceRefs!;
      const binding = catalogRecords.get(selectedItem.bindingId);
      const variant = catalogRecords.get(selectedItem.variantId);
      const product = catalogRecords.get(selectedItem.productId);
      const family =
        binding?.recordType === "binding"
          ? catalogRecords.get(binding.familyId)
          : undefined;
      if (
        binding?.recordType !== "binding" ||
        variant?.recordType !== "variant" ||
        product?.recordType !== "product" ||
        family?.recordType !== "family" ||
        binding.merchantId !== node.merchantId ||
        binding.variantId !== variant.id ||
        variant.productId !== product.id ||
        variant.sku !== selectedItem.sku ||
        product.itemKind !== selectedItem.itemKind ||
        variant.shopify?.variantGid !== selectedItem.variantGid ||
        family.kind !== node.kind ||
        node.capabilityId !== `bound:${node.catalogVersion}:${binding.id}` ||
        family.requiredAssetIds.some(
          (id) =>
            !node.customizationAssets?.some((asset) => asset.assetId === id),
        )
      )
        throw new Error("INVALID_CATALOG_SELECTION");
      if (
        binding.resources.length !== resourceRefs.length ||
        new Set(resourceRefs.map((ref) => ref.resourceId)).size !==
          resourceRefs.length ||
        binding.resources.some(
          (required) =>
            !resourceRefs.some(
              (ref) =>
                ref.resourceId === required.resourceId &&
                ref.unitsPerItem === required.unitsPerItem,
            ),
        )
      )
        throw new Error("INVALID_RESOURCE_REFERENCES");
      for (const ref of [...resourceRefs].sort((a, b) =>
        a.resourceId.localeCompare(b.resourceId),
      )) {
        const key = `${actionKey}:${node.nodeId}:${ref.resourceId}`;
        const quantity =
          Math.ceil(node.quantity * ref.unitsPerItem * 1000) / 1000;
        const request = {
          planId: plan.planId,
          node,
          resourceId: ref.resourceId,
          quantity,
        };
        const existing = await client.query<{
          matches: boolean;
          status: string;
        }>(
          "select request_json=$2::jsonb as matches,status from catalog_resource_reservations where action_key=$1",
          [key, request],
        );
        if (existing.rows[0]) {
          if (!existing.rows[0].matches) throw new Error("ACTION_KEY_CONFLICT");
          if (existing.rows[0].status !== "active")
            throw new Error("RESERVATION_RELEASED");
          keys.push(key);
          continue;
        }
        const state = await client.query<{
          merchant_id: string;
          kind: string;
          unit: string;
          available: string;
          period_minutes: number | null;
          observed_at: Date;
          status: string;
          source_reference: string;
        }>(
          "select * from catalog_resource_state where resource_id=$1 for update",
          [ref.resourceId],
        );
        const row = state.rows[0];
        if (
          !row ||
          row.merchant_id !== node.merchantId ||
          row.kind !== ref.kind ||
          row.unit !== ref.unit ||
          row.status !== "known"
        )
          throw new Error("RESOURCE_UNAVAILABLE");
        if (
          row.observed_at.getTime() !== Date.parse(ref.observedAt) ||
          row.source_reference !== ref.sourceReference ||
          row.period_minutes !== (ref.periodMinutes ?? null)
        )
          throw new Error("RESOURCE_CHANGED_REVALIDATE");
        if (ref.kind === "inventory") {
          const used = await client.query<{ used: string }>(
            "select coalesce(sum(quantity),0) as used from catalog_resource_reservations where resource_id=$1 and status='active'",
            [ref.resourceId],
          );
          if (Number(row.available) - Number(used.rows[0]?.used) < quantity)
            throw new Error("INSUFFICIENT_INVENTORY");
        } else {
          if (!node.startsAt || !node.completesAt || Number(row.available) <= 0)
            throw new Error("INVALID_RESOURCE_INTERVAL");
          const duration =
            (Date.parse(node.completesAt) - Date.parse(node.startsAt)) / 60000;
          if (
            duration <
            Math.ceil(
              (quantity / Number(row.available)) * (row.period_minutes ?? 0),
            )
          )
            throw new Error("PROCESSING_RATE_CHANGED_REVALIDATE");
          const overlap = await client.query(
            "select 1 from catalog_resource_reservations where resource_id=$1 and status='active' and starts_at<$3 and completes_at>$2",
            [ref.resourceId, node.startsAt, node.completesAt],
          );
          if (overlap.rowCount) throw new Error("PROCESSING_INTERVAL_RESERVED");
        }
        await client.query(
          `insert into catalog_resource_reservations(action_key,request_json,order_id,plan_id,node_id,catalog_version,resource_id,quantity,starts_at,completes_at,trace_id)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            key,
            request,
            plan.orderId,
            plan.planId,
            node.nodeId,
            node.catalogVersion,
            ref.resourceId,
            quantity,
            ref.kind === "processing" ? node.startsAt : null,
            ref.kind === "processing" ? node.completesAt : null,
            traceId,
          ],
        );
        await persistEvent(
          {
            eventId: effectId(key),
            traceId,
            orderId: plan.orderId,
            planId: plan.planId,
            merchantId: node.merchantId,
            eventType: "catalog.resource.reserved",
            ts: new Date().toISOString(),
            source: "tiger",
            severity: "INFO",
            payload: {
              actionKey: key,
              resourceId: ref.resourceId,
              quantity,
              nodeId: node.nodeId,
              catalogVersion: node.catalogVersion,
            },
          },
          client,
        );
        keys.push(key);
      }
    }
    return keys;
  });
}

/** Call only after jobs using this plan have been reconciled/superseded. */
export async function releaseCatalogPlan(
  planId: string,
  traceId: string,
  actionKey: string,
): Promise<void> {
  if (!traceId.trim() || !actionKey.trim() || !planId.trim())
    throw new Error("INVALID_RELEASE_REQUEST");
  await transaction(async (client) => {
    const previous = await client.query<{ plan_id: string }>(
      "select plan_id from molecule_events where event_id=$1",
      [effectId(actionKey)],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].plan_id !== planId)
        throw new Error("ACTION_KEY_CONFLICT");
      return;
    }
    await client.query(
      "update catalog_resource_reservations set status='released' where plan_id=$1 and status='active'",
      [planId],
    );
    await persistEvent(
      {
        eventId: effectId(actionKey),
        traceId,
        planId,
        eventType: "catalog.resources.released",
        ts: new Date().toISOString(),
        source: "tiger",
        severity: "INFO",
        payload: { actionKey },
      },
      client,
    );
  });
}
