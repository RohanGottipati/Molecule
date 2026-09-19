import {
  CandidateCapabilitySchema,
  CatalogCoverageSchema,
  CatalogPricingSchema,
  CatalogTimingSchema,
  QuantityRangeSchema,
  CatalogRecordSchema,
  type CandidateCapability,
  type CatalogRecord,
  type ProductIntent,
} from "@molecule/contracts";
import { readCatalog, listClaimsForField, type DbClient } from "@molecule/db";

import { resolveClaims } from "./resolution.js";

export interface CatalogCandidateReport {
  catalogVersion?: string;
  candidates: CandidateCapability[];
  exclusions: { bindingId: string; reasons: string[] }[];
}

/** Bound offers are exact item/service options. Availability is never inferred from a product count. */
export async function catalogCandidates(
  client: DbClient,
  intent?: ProductIntent,
  excludedMerchants: string[] = [],
  bindingId?: string,
): Promise<CatalogCandidateReport> {
  const active = await client.query<{ catalog_version: string }>(
    "select catalog_version from catalog_active_version",
  );
  const version = active.rows[0]?.catalog_version;
  if (!version) return { candidates: [], exclusions: [] };
  const records = bindingId
    ? (
        await client.query<{ record_json: unknown }>(
          `
    with binding as (select record_json b from catalog_records where catalog_version=$1 and record_id=$2 and record_type='binding'),
    variant as (select record_json v from catalog_records,binding where catalog_version=$1 and record_id=b->>'variantId'),
    ids as (select $2 as id union select b->>'familyId' from binding union select b->>'variantId' from binding
      union select b->>'merchantId' from binding union select v->>'productId' from variant
      union select f.value from binding cross join lateral jsonb_each_text(b->'factIds') f
      union select jsonb_array_elements(b->'resources')->>'resourceId' from binding)
    select record_json from catalog_records where catalog_version=$1 and record_id in (select id from ids)`,
          [version, bindingId],
        )
      ).rows.map((row) => CatalogRecordSchema.parse(row.record_json))
    : await readCatalog(version, client);
  const byId = new Map(records.map((r) => [r.id, r]));
  const candidates: CandidateCapability[] = [];
  const exclusions: CatalogCandidateReport["exclusions"] = [];
  const state = await client.query<{
    resource_id: string;
    kind: "inventory" | "processing";
    unit: string;
    available: string;
    period_minutes: number | null;
    observed_at: Date;
    source_reference: string;
    status: string;
    reserved: string;
  }>(`select s.*,
    coalesce((select sum(r.quantity) from catalog_resource_reservations r where r.resource_id=s.resource_id and r.status='active' and s.kind='inventory'),0) as reserved
    from catalog_resource_state s`);
  const occupied = await client.query<{
    resource_id: string;
    starts_at: Date;
    completes_at: Date;
  }>(
    "select resource_id,starts_at,completes_at from catalog_resource_reservations where status='active' and starts_at is not null order by resource_id,starts_at",
  );
  const resources = new Map(state.rows.map((r) => [r.resource_id, r]));
  const statuses = await client.query<{ merchant_id: string; status: string }>(
    "select merchant_id,status from merchants",
  );
  const merchants = new Map(
    statuses.rows.map((m) => [m.merchant_id, m.status]),
  );
  for (const binding of records.filter((r) => r.recordType === "binding")) {
    const reasons: string[] = [];
    const family = byId.get(binding.familyId);
    const variant = byId.get(binding.variantId);
    if (family?.recordType !== "family" || variant?.recordType !== "variant")
      throw new Error("CORRUPT_CATALOG_BINDING");
    const product = byId.get(variant.productId);
    if (product?.recordType !== "product")
      throw new Error("CORRUPT_CATALOG_PRODUCT");
    if (excludedMerchants.includes(binding.merchantId))
      reasons.push("merchant_excluded");
    if (merchants.get(binding.merchantId) !== "online")
      reasons.push("merchant_not_online");
    if (variant.material.status !== "known")
      reasons.push(`material:${variant.material.status}`);
    if (!variant.supportedOperations.includes(family.operation))
      reasons.push(`unsupported_operation:${family.operation}`);
    const resolvedValues = new Map<string, unknown>();
    const sourceClaimIds: string[] = [];
    const facts = Object.fromEntries(
      Object.entries(binding.factIds).map(([field, id]) => [
        field,
        byId.get(id),
      ]),
    );
    for (const [field, fact] of Object.entries(facts)) {
      if (fact?.recordType !== "fact" || fact.assertion.status !== "known")
        reasons.push(
          `${field}:${fact?.recordType === "fact" ? fact.assertion.status : "missing"}`,
        );
    }
    for (const [field, fact] of Object.entries(facts)) {
      if (fact?.recordType !== "fact" || fact.assertion.status !== "known")
        continue;
      const resolution = resolveClaims(
        await listClaimsForField(
          binding.merchantId,
          `catalog.${version}.${binding.id}.${field}`,
          client,
        ),
      );
      if (resolution.status !== "resolved")
        reasons.push(`${field}:${resolution.status}`);
      else {
        resolvedValues.set(field, resolution.winner.claim.normalizedValue);
        sourceClaimIds.push(resolution.winner.claim.claimId);
      }
    }
    const resourceRefs = binding.resources.flatMap((ref) => {
      const resource = resources.get(ref.resourceId);
      if (!resource || resource.status !== "known") {
        reasons.push(`${ref.resourceId}:${resource?.status ?? "missing"}`);
        return [];
      }
      const available = Math.max(
        0,
        Number(resource.available) - Number(resource.reserved),
      );
      if (available === 0) reasons.push(`${ref.resourceId}:unavailable`);
      if (resource.unit !== variant.unit)
        reasons.push(`${ref.resourceId}:unit_mismatch`);
      return [
        {
          resourceId: ref.resourceId,
          kind: resource.kind,
          unit: resource.unit,
          unitsPerItem: ref.unitsPerItem,
          available,
          ...(resource.period_minutes === null
            ? {}
            : { periodMinutes: resource.period_minutes }),
          observedAt: resource.observed_at.toISOString(),
          sourceReference: resource.source_reference,
          ...(resource.kind === "processing"
            ? {
                occupiedIntervals: occupied.rows
                  .filter((r) => r.resource_id === ref.resourceId)
                  .map((r) => ({
                    startsAt: r.starts_at.toISOString(),
                    completesAt: r.completes_at.toISOString(),
                  })),
              }
            : {}),
        },
      ];
    });
    if (reasons.length) {
      exclusions.push({ bindingId: binding.id, reasons });
      continue;
    }
    function value(field: string): unknown {
      const fact = facts[field];
      if (fact?.recordType !== "fact" || fact.assertion.status !== "known")
        throw new Error("UNRESOLVED_CATALOG_FACT");
      return resolvedValues.get(field);
    }
    const pricing = CatalogPricingSchema.parse(value("pricing"));
    const timing = CatalogTimingSchema.parse(value("timing"));
    const quantity = QuantityRangeSchema.parse(value("quantity"));
    const coverage = CatalogCoverageSchema.parse(value("coverage"));
    if (!coverage.countries.includes("CA"))
      reasons.push("fulfilment:CA_not_supported");
    if (pricing.currency !== (intent?.currency ?? "CAD"))
      reasons.push("currency_mismatch");
    if (quantity.unit !== variant.unit) reasons.push("quantity_unit_mismatch");
    const attributes: Record<string, unknown> = {
      ...variant.attributes,
      category: product.category,
      material:
        variant.material.status === "known" ? variant.material.value : null,
    };
    const ports = (items: typeof family.produces): typeof family.produces =>
      items.map((port) => ({
        ...port,
        name:
          port.name === "$item"
            ? String(attributes.product ?? product.name)
            : port.name,
        unit: port.unit ?? variant.unit,
        attributes: {
          ...(port.name === "$item" ? attributes : {}),
          ...Object.fromEntries(
            Object.entries(port.attributes).map(([key, val]) => [
              key,
              val === "$item" ? (attributes.product ?? product.name) : val,
            ]),
          ),
          operation: family.operation,
        },
      }));
    const produces = ports(family.produces);
    // Operation describes the produced stage, not a property required on the incoming blank.
    const accepts = ports(family.accepts).map((port) => {
      const { operation: _, ...attrs } = port.attributes;
      return { ...port, attributes: attrs };
    });
    if (intent) {
      const relevant =
        family.kind === "SUPPLY"
          ? intent.desiredOutputs.some((output) =>
              produces.some(
                (port) =>
                  String(port.attributes.product ?? port.name).toLowerCase() ===
                  String(
                    output.attributes.product ?? output.name,
                  ).toLowerCase(),
              ),
            )
          : intent.transformations.some((t) => t.kind === family.operation) &&
            ((family.kind !== "TRANSFORM" &&
              (family.kind !== "FULFILL" ||
                intent.transformations.some((t) =>
                  ["assembly", "packaging"].includes(t.kind),
                ))) ||
              accepts.some((port) =>
                intent.desiredOutputs.some(
                  (output) =>
                    String(
                      port.attributes.product ?? port.name,
                    ).toLowerCase() ===
                    String(
                      output.attributes.product ?? output.name,
                    ).toLowerCase(),
                ),
              ));
      if (!relevant) continue;
      if (
        family.requiredAssetIds.some(
          (id) => !intent.assets.some((asset) => asset.assetId === id),
        )
      )
        reasons.push("required_asset_missing");
    }
    if (reasons.length) {
      exclusions.push({ bindingId: binding.id, reasons });
      continue;
    }
    const merchant = byId.get(binding.merchantId);
    const capabilityId = `bound:${version}:${binding.id}`;
    const inventory = resourceRefs.filter((r) => r.kind === "inventory");
    // Processing rates live on resourceRefs. Do not mistake them for finite stock.
    const available = inventory.length
      ? Math.min(...inventory.map((r) => r.available / r.unitsPerItem))
      : quantity.max;
    const linked: CatalogRecord[] = [
      binding,
      variant,
      product,
      family,
      ...Object.values(facts).filter(
        (f): f is CatalogRecord => f !== undefined,
      ),
      ...binding.resources.flatMap((ref) => byId.get(ref.resourceId) ?? []),
    ];
    candidates.push(
      CandidateCapabilitySchema.parse({
        capabilityId,
        merchantId: binding.merchantId,
        score: 100 - pricing.unitPrice,
        blockedReasons: [],
        catalogVersion: version,
        selectedItem: {
          bindingId: binding.id,
          productId: product.id,
          variantId: variant.id,
          sku: variant.sku,
          itemKind: product.itemKind,
          shopDomain:
            merchant?.recordType === "merchant"
              ? merchant.shopDomain
              : undefined,
          variantGid: variant.shopify?.variantGid,
        },
        resourceRefs,
        transferMinutes: timing.transferMinutes,
        requiredAssetIds: family.requiredAssetIds,
        synthetic: linked.some((record) => record.evidence.synthetic),
        capability: {
          capabilityId,
          merchantId: binding.merchantId,
          kind: family.kind,
          name: family.operation,
          description: product.name,
          accepts,
          produces,
          quantity,
          pricing: {
            currency: pricing.currency,
            unitPrice: pricing.unitPrice,
            setupFee: pricing.setupFee,
            minimumTotal: pricing.minimumTotal,
          },
          leadTime: {
            min: timing.leadMinutes,
            max: timing.leadMinutes,
            unit: "minutes",
          },
          capacity: { available },
          hardRules: [],
          softRules: [],
          sourceClaimIds,
        },
      }),
    );
  }
  return { catalogVersion: version, candidates, exclusions };
}
