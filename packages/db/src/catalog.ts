import { createHash } from "node:crypto";
import {
  validateCatalogJsonl,
  CatalogRecordSchema,
  type CatalogRecord,
  type CatalogValidationReport,
} from "@molecule/contracts";
import { transaction, type DbClient } from "./client.js";
import { insertClaim } from "./claims.js";
import { effectId, persistEvent } from "./operations.js";

export class CatalogImportError extends Error {
  constructor(public readonly report: CatalogValidationReport) {
    super("Catalog delivery failed validation");
  }
}

async function event(
  client: DbClient,
  traceId: string,
  actionKey: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await persistEvent(
    {
      eventId: effectId(actionKey),
      traceId,
      eventType,
      ts: new Date().toISOString(),
      source: "tiger",
      severity: "INFO",
      payload: { actionKey, ...payload },
    },
    client,
  );
}

/** Import is immutable and idempotent; it never activates a version implicitly. */
export async function importCatalog(
  jsonl: string,
  traceId: string,
): Promise<CatalogValidationReport> {
  if (!traceId.trim()) throw new Error("traceId is required");
  const report = validateCatalogJsonl(jsonl);
  if (report.errors.length || !report.manifest)
    throw new CatalogImportError(report);
  const manifest = report.manifest;
  const canonical = JSON.stringify({
    manifest,
    records: [...report.records].sort((a, b) => a.id.localeCompare(b.id)),
  });
  const checksum = createHash("sha256").update(canonical).digest("hex");
  await transaction(async (client) => {
    const previous = await client.query<{ checksum: string }>(
      "select checksum from catalog_versions where catalog_version=$1",
      [manifest.catalogVersion],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].checksum !== checksum)
        throw new Error("CATALOG_VERSION_IMMUTABLE");
      return;
    }
    await client.query(
      "insert into catalog_versions(catalog_version,checksum,manifest_json,report_json) values($1,$2,$3,$4)",
      [
        manifest.catalogVersion,
        checksum,
        manifest,
        {
          errors: report.errors,
          exclusions: report.exclusions,
          coverage: report.coverage,
        },
      ],
    );
    for (const record of report.records) {
      await client.query(
        "insert into catalog_records(catalog_version,record_id,record_type,record_json) values($1,$2,$3,$4)",
        [manifest.catalogVersion, record.id, record.recordType, record],
      );
    }
    await event(
      client,
      traceId,
      `catalog:import:${manifest.catalogVersion}`,
      "catalog.version.imported",
      {
        catalogVersion: manifest.catalogVersion,
        checksum,
        recordCount: report.records.length,
        coverage: report.coverage,
      },
    );
  });
  return report;
}

export async function readCatalog(
  version: string,
  client: DbClient,
): Promise<CatalogRecord[]> {
  const result = await client.query<{ record_json: unknown }>(
    "select record_json from catalog_records where catalog_version=$1 order by record_id",
    [version],
  );
  return result.rows.map((row) => CatalogRecordSchema.parse(row.record_json));
}

/** Activation/rollback changes one pointer transactionally. Resource observations never roll back. */
export async function activateCatalog(
  version: string,
  traceId: string,
  actionKey: string,
): Promise<void> {
  if (!traceId.trim() || !actionKey.trim())
    throw new Error("traceId and actionKey are required");
  await transaction(async (client) => {
    const existingEvent = await client.query<{
      payload: { catalogVersion: string };
    }>("select payload from molecule_events where event_id=$1", [
      effectId(actionKey),
    ]);
    if (existingEvent.rows[0]) {
      if (existingEvent.rows[0].payload.catalogVersion !== version)
        throw new Error("ACTION_KEY_CONFLICT");
      return;
    }
    const exists = await client.query(
      "select 1 from catalog_versions where catalog_version=$1",
      [version],
    );
    if (!exists.rowCount) throw new Error("UNKNOWN_CATALOG_VERSION");
    const records = await readCatalog(version, client);
    // Provision local identities only. This does not create stores or mark merchants online.
    for (const merchant of records.filter((r) => r.recordType === "merchant")) {
      await client.query(
        "insert into merchants(merchant_id,name,status) values($1,$2,'unknown') on conflict(merchant_id) do nothing",
        [merchant.id, merchant.name],
      );
      if (merchant.shopDomain) {
        const mapped = await client.query<{ merchant_id: string }>(
          "select merchant_id from merchant_stores where shopify_domain=$1",
          [merchant.shopDomain],
        );
        if (mapped.rows.some((row) => row.merchant_id !== merchant.id))
          throw new Error("STORE_MAPPING_CONFLICT");
        if (!mapped.rowCount)
          await client.query(
            "insert into merchant_stores(store_id,merchant_id,shopify_domain) values($1,$2,$3)",
            [
              `catalog:${merchant.id}:${merchant.shopDomain}`,
              merchant.id,
              merchant.shopDomain,
            ],
          );
      }
    }
    for (const fact of records.filter((r) => r.recordType === "fact")) {
      await insertClaim(
        {
          claimId: `catalog:${version}:${fact.id}`,
          merchantId: fact.merchantId,
          field: `catalog.${version}.${fact.subjectId}.${fact.field}`,
          normalizedValue:
            fact.assertion.status === "known" ? fact.assertion.value : null,
          source: { kind: "api", reference: fact.evidence.sourceReference },
          observedAt: fact.evidence.observedAt,
          ingestedAt: new Date().toISOString(),
          sourceAuthority: 0.8,
          extractionConfidence: 1,
          resolutionStatus:
            fact.assertion.status === "known"
              ? "active"
              : fact.assertion.status,
          evidenceText: `${fact.evidence.synthetic ? "Synthetic. " : ""}Validated catalog ${version}; ${fact.id}; ${fact.assertion.status}`,
        },
        client,
      );
    }
    for (const resource of records.filter((r) => r.recordType === "resource")) {
      const previous = await client.query<{
        merchant_id: string;
        kind: string;
        unit: string;
        period_minutes: number | null;
      }>(
        "select merchant_id,kind,unit,period_minutes from catalog_resource_state where resource_id=$1 for update",
        [resource.id],
      );
      const old = previous.rows[0];
      if (
        old &&
        (old.merchant_id !== resource.merchantId ||
          old.kind !== resource.kind ||
          old.unit !== resource.unit ||
          old.period_minutes !== (resource.periodMinutes ?? null))
      )
        throw new Error("RESOURCE_IDENTITY_CONFLICT");
      await client.query(
        `insert into catalog_resource_state(resource_id,merchant_id,kind,unit,period_minutes,available,observed_at,source_reference,synthetic,status)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(resource_id) do update set
        available=excluded.available,observed_at=excluded.observed_at,source_reference=excluded.source_reference,synthetic=excluded.synthetic,status=excluded.status
        where catalog_resource_state.observed_at<excluded.observed_at`,
        [
          resource.id,
          resource.merchantId,
          resource.kind,
          resource.unit,
          resource.periodMinutes ?? null,
          resource.availability.status === "known"
            ? resource.availability.value
            : 0,
          resource.evidence.observedAt,
          resource.evidence.sourceReference,
          resource.evidence.synthetic,
          resource.availability.status,
        ],
      );
    }
    for (const variant of records) {
      if (variant.recordType !== "variant" || !variant.shopify) continue;
      const refs = variant.shopify;
      const merchant = records.find(
        (r) => r.recordType === "merchant" && r.id === variant.merchantId,
      );
      if (merchant?.recordType !== "merchant" || !merchant.shopDomain)
        throw new Error("MISSING_STORE_MAPPING");
      const mirrored = await client.query(
        "select 1 from shopify_variants where variant_gid=$1 and product_gid=$2 and merchant_id=$3 and shop_domain=$4",
        [
          refs.variantGid,
          refs.productGid,
          variant.merchantId,
          merchant.shopDomain,
        ],
      );
      if (!mirrored.rowCount) throw new Error("CATALOG_VARIANT_NOT_MIRRORED");
      await client.query(
        "insert into catalog_variant_mappings(catalog_version,variant_id,shop_domain,product_gid,variant_gid) values($1,$2,$3,$4,$5) on conflict do nothing",
        [
          version,
          variant.id,
          merchant.shopDomain,
          refs.productGid,
          refs.variantGid,
        ],
      );
    }
    await client.query(
      `insert into catalog_active_version(singleton,catalog_version) values(true,$1)
      on conflict(singleton) do update set previous_version=catalog_active_version.catalog_version,catalog_version=excluded.catalog_version
      where catalog_active_version.catalog_version<>excluded.catalog_version`,
      [version],
    );
    await event(client, traceId, actionKey, "catalog.version.activated", {
      catalogVersion: version,
    });
  });
}
