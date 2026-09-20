import { createHash } from "node:crypto";
import { effectId, persistEvent, transaction } from "@molecule/db";
import { ingestClaim } from "./repository.js";

export interface CatalogInventoryObservation {
  shop: string;
  inventoryItemId: string | number;
  locationId?: string | number;
  available: number;
  observedAt?: string;
  traceId: string;
}
const gid = (kind: string, id: string | number) =>
  String(id).startsWith("gid://") ? String(id) : `gid://shopify/${kind}/${id}`;

/** Batch inventory reads and signed webhooks must call this same exact-location boundary. */
export async function observeCatalogInventory(
  input: CatalogInventoryObservation,
): Promise<{
  status: "unmapped" | "stale" | "unchanged" | "changed";
  resourceId?: string;
  merchantId?: string;
}> {
  if (!input.traceId.trim() || !Number.isFinite(input.available))
    throw new Error("INVALID_INVENTORY_OBSERVATION");
  if (input.locationId === undefined || !input.observedAt)
    return { status: "unmapped" };
  if (
    !Number.isFinite(Date.parse(input.observedAt)) ||
    Date.parse(input.observedAt) > Date.now() + 60_000
  )
    throw new Error("INVALID_OBSERVATION_TIME");
  const shop =
    input.shop.toLowerCase().replace(/\.myshopify\.com$/, "") +
    ".myshopify.com";
  const item = gid("InventoryItem", input.inventoryItemId);
  const location = gid("Location", input.locationId);
  const source = `${shop}/${item}/${location}`;
  return transaction(async (client) => {
    const mapping = await client.query<{
      resource_id: string;
      merchant_id: string;
      kind: string;
      available: string;
      observed_at: Date;
      source_reference: string;
      status: string;
    }>(
      `
      select s.* from catalog_active_version a
      join catalog_records r on r.catalog_version=a.catalog_version and r.record_type='resource'
      join merchant_stores m on m.merchant_id=r.record_json->>'merchantId'
      join catalog_resource_state s on s.resource_id=r.record_id
      where m.shopify_domain=$1 and r.record_json->>'inventoryItemGid'=$2 and r.record_json->>'locationGid'=$3
      for update of s`,
      [shop, item, location],
    );
    if (!mapping.rowCount) return { status: "unmapped" };
    if (mapping.rowCount !== 1) throw new Error("AMBIGUOUS_INVENTORY_RESOURCE");
    const resource = mapping.rows[0]!;
    const ids = {
      resourceId: resource.resource_id,
      merchantId: resource.merchant_id,
    };
    const observedAt = new Date(input.observedAt!);
    if (observedAt < resource.observed_at) return { status: "stale", ...ids };
    const available = Math.max(0, input.available);
    if (
      observedAt.getTime() === resource.observed_at.getTime() &&
      Number(resource.available) === available
    )
      return { status: "unchanged", ...ids };
    const field = `resource.${resource.resource_id}.${resource.kind === "inventory" ? "inventory" : "capacity"}`;
    await ingestClaim(
      {
        merchantId: resource.merchant_id,
        field,
        rawValue: available,
        sourceKind: "shopify",
        sourceReference: source,
        observedAt: observedAt.toISOString(),
        sourceAuthority: 0.9,
        extractionConfidence: 1,
        evidenceText: `Exact-location Shopify availability ${input.available}; resource ${resource.resource_id}`,
      },
      input.traceId,
      client,
    );

    // The claim is only a proposal. `ingestClaim` resolves the merchant in the
    // same transaction; only the winning resolved value may cross into the
    // mutable catalog state served to candidate search. A conflict changes the
    // status (so the resource is excluded) but preserves the last known-good
    // value, timestamp and source for reconciliation.
    const resolution = await client.query<{
      status: "resolved" | "conflicted" | "unknown";
      value: unknown;
      scores: { signature?: string };
      observed_at: Date | null;
      source_reference: string | null;
    }>(
      `select r.status,r.value,r.scores,c.observed_at,c.source_reference
       from canonical_resolutions r
       left join canonical_claims c on c.claim_id=r.winning_claim_id
       where r.merchant_id=$1 and r.field=$2`,
      [resource.merchant_id, field],
    );
    const verdict = resolution.rows[0];
    if (!verdict) throw new Error("MISSING_INVENTORY_RESOLUTION");
    const resolvedAvailable = Number(verdict.value);
    if (
      verdict.status === "resolved" &&
      (!Number.isFinite(resolvedAvailable) || resolvedAvailable < 0)
    )
      throw new Error("INVALID_RESOLVED_INVENTORY");
    const status = verdict.status === "resolved" ? "known" : verdict.status;
    const observationKey = createHash("sha256")
      .update(
        JSON.stringify([
          resource.resource_id,
          field,
          verdict.scores?.signature,
          status,
        ]),
      )
      .digest("hex");
    if (verdict.status === "resolved") {
      await client.query(
        "update catalog_resource_state set available=$2,observed_at=$3,source_reference=$4,status='known' where resource_id=$1",
        [
          resource.resource_id,
          resolvedAvailable,
          verdict.observed_at ?? observedAt,
          verdict.source_reference ?? source,
        ],
      );
    } else {
      await client.query(
        "update catalog_resource_state set status=$2 where resource_id=$1",
        [resource.resource_id, status],
      );
      const review = await client.query(
        `insert into rox_review_queue
           (task_id,kind,merchant_id,field,detail,proposed_action)
         values ($1,$2,$3,$4,$5,$6)
         on conflict(task_id) do nothing
         returning task_id`,
        [
          `catalog-resolution:${observationKey}`,
          verdict.status === "conflicted" ? "conflict" : "missing_fact",
          resource.merchant_id,
          field,
          {
            resourceId: resource.resource_id,
            status: verdict.status,
            resolutionSignature: verdict.scores?.signature ?? null,
            lastKnownGood: {
              available: Number(resource.available),
              observedAt: resource.observed_at.toISOString(),
              sourceReference: resource.source_reference,
            },
          },
          {
            action: "reconcile_catalog_inventory",
            requiresApproval: true,
          },
        ],
      );
      if (review.rowCount)
        await persistEvent(
          {
            eventId: effectId(`rox-review:${observationKey}`),
            traceId: input.traceId,
            merchantId: resource.merchant_id,
            eventType: "rox.review.queued",
            source: "rox",
            severity: "WARN",
            ts: new Date().toISOString(),
            payload: {
              taskId: `catalog-resolution:${observationKey}`,
              resourceId: resource.resource_id,
              field,
              status: verdict.status,
            },
          },
          client,
        );
    }
    const changed =
      status !== resource.status ||
      (verdict.status === "resolved" &&
        resolvedAvailable !== Number(resource.available));
    if (changed) {
      await client.query(
        `insert into catalog_recovery_requests(order_id,resource_id,observation_key)
        select order_id,$1,$2 from order_sessions s
        where s.session_json->>'state' in ('PLAN_VALIDATED','AWAITING_APPROVAL','COMPLETED','NEEDS_HUMAN') and (exists (
          select 1 from jsonb_array_elements(coalesce(s.session_json->'activePlan'->'nodes','[]')) n
          cross join lateral jsonb_array_elements(coalesce(n->'resourceRefs','[]')) ref where ref->>'resourceId'=$1) or (s.session_json->>'state'='NEEDS_HUMAN' and exists (select 1 from catalog_recovery_requests previous where previous.order_id=s.order_id and previous.resource_id=$1)))
        on conflict(order_id,resource_id) do update set observation_key=excluded.observation_key,status='pending',updated_at=now()`,
        [resource.resource_id, observationKey],
      );
    }
    await persistEvent(
      {
        eventId: effectId(`catalog-observation:${observationKey}`),
        traceId: input.traceId,
        merchantId: resource.merchant_id,
        eventType: changed
          ? "catalog.resource.changed"
          : "catalog.resource.observed",
        source: "shopify",
        severity: status === "conflicted" ? "WARN" : "INFO",
        ts: new Date().toISOString(),
        payload: {
          ...ids,
          observationKey,
          available:
            verdict.status === "resolved"
              ? resolvedAvailable
              : Number(resource.available),
          proposedAvailable: available,
          status,
          sourceReference: source,
          observedAt: input.observedAt,
        },
      },
      client,
    );
    return { status: changed ? "changed" : "unchanged", ...ids };
  });
}
