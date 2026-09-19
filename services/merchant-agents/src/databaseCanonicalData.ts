import {
  CanonicalClaimSchema,
  MerchantCapabilitySchema,
  type CanonicalClaim,
} from "@molecule/contracts";
import { getPool } from "@molecule/db";
import type {
  CanonicalDataClient,
  InventorySnapshot,
} from "./canonicalDataClient.js";

export class DatabaseCanonicalDataClient implements CanonicalDataClient {
  async getCapability(merchantId: string, capabilityId: string) {
    const result = await getPool().query<{ capability_json: unknown }>(
      "select capability_json from capabilities where merchant_id=$1 and capability_id=$2",
      [merchantId, capabilityId],
    );
    return result.rows[0]
      ? MerchantCapabilitySchema.parse(result.rows[0].capability_json)
      : undefined;
  }

  async getCanonicalClaims(
    merchantId: string,
    fields: string[],
  ): Promise<CanonicalClaim[]> {
    const result = await getPool().query<{
      claim_id: string;
      merchant_id: string;
      field: string;
      normalized_value: unknown;
      normalized_unit: string | null;
      source_kind: string;
      source_reference: string;
      source_checksum: string | null;
      observed_at: Date | null;
      ingested_at: Date;
      source_authority: string;
      extraction_confidence: string;
      resolution_status: string;
      evidence_text: string | null;
    }>(
      "select * from canonical_claims where merchant_id=$1 and (cardinality($2::text[])=0 or field=any($2::text[]))",
      [merchantId, fields],
    );
    return result.rows.map((row) =>
      CanonicalClaimSchema.parse({
        claimId: row.claim_id,
        merchantId: row.merchant_id,
        field: row.field,
        normalizedValue: row.normalized_value,
        normalizedUnit: row.normalized_unit ?? undefined,
        source: {
          kind: row.source_kind,
          reference: row.source_reference,
          checksum: row.source_checksum ?? undefined,
        },
        observedAt: row.observed_at?.toISOString(),
        ingestedAt: row.ingested_at.toISOString(),
        sourceAuthority: Number(row.source_authority),
        extractionConfidence: Number(row.extraction_confidence),
        resolutionStatus: row.resolution_status,
        evidenceText: row.evidence_text ?? undefined,
      }),
    );
  }

  async getInventory(
    merchantId: string,
    sku: string,
  ): Promise<InventorySnapshot | undefined> {
    const claims = await this.getCanonicalClaims(merchantId, [
      `inventory.${sku}`,
    ]);
    if (
      claims.some((claim) =>
        ["conflicted", "unknown", "quarantined"].includes(
          claim.resolutionStatus,
        ),
      )
    )
      return undefined;
    const active = claims.filter(
      (claim) => claim.resolutionStatus === "active",
    );
    const first = active[0];
    if (
      !first ||
      active.some((claim) => claim.normalizedValue !== first.normalizedValue) ||
      typeof first.normalizedValue !== "number" ||
      first.normalizedValue < 0
    )
      return undefined;
    return {
      merchantId,
      sku,
      available: first.normalizedValue,
      asOf: first.observedAt ?? first.ingestedAt,
    };
  }
}
