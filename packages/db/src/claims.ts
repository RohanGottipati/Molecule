import { CanonicalClaimSchema, type CanonicalClaim } from "@molecule/contracts";

import { getPool, type DbClient } from "./client.js";

interface ClaimRow {
  claim_id: string;
  merchant_id: string;
  field: string;
  normalized_value: unknown;
  normalized_unit: string | null;
  source_kind: CanonicalClaim["source"]["kind"];
  source_reference: string;
  source_checksum: string | null;
  observed_at: Date | null;
  ingested_at: Date;
  source_authority: string;
  extraction_confidence: string;
  resolution_status: CanonicalClaim["resolutionStatus"];
  evidence_text: string | null;
}

function rowToClaim(row: ClaimRow): CanonicalClaim {
  return CanonicalClaimSchema.parse({
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
  });
}

/** Insert a new claim. Never overwrites an existing claim_id. */
export async function insertClaim(
  claim: CanonicalClaim,
  client: DbClient = getPool(),
): Promise<void> {
  claim = CanonicalClaimSchema.parse(claim);
  await client.query(
    `insert into canonical_claims
       (claim_id, merchant_id, field, normalized_value, normalized_unit,
        source_kind, source_reference, source_checksum, observed_at,
        ingested_at, source_authority, extraction_confidence,
        resolution_status, evidence_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (claim_id) do nothing`,
    [
      claim.claimId,
      claim.merchantId,
      claim.field,
      JSON.stringify(claim.normalizedValue),
      claim.normalizedUnit ?? null,
      claim.source.kind,
      claim.source.reference,
      claim.source.checksum ?? null,
      claim.observedAt ?? null,
      claim.ingestedAt,
      claim.sourceAuthority,
      claim.extractionConfidence,
      claim.resolutionStatus,
      claim.evidenceText ?? null,
    ],
  );
}

/** All non-superseded claims for a merchant/field, newest first. */
export async function listClaimsForField(
  merchantId: string,
  field: string,
  client: DbClient = getPool(),
): Promise<CanonicalClaim[]> {
  const result = await client.query<ClaimRow>(
    `select * from canonical_claims
     where merchant_id = $1 and field = $2 and resolution_status != 'superseded'
     order by ingested_at desc`,
    [merchantId, field],
  );
  return result.rows.map(rowToClaim);
}

export async function listMerchantClaims(
  merchantId: string,
  client: DbClient = getPool(),
): Promise<CanonicalClaim[]> {
  const rows = await client.query<ClaimRow>(
    "select * from canonical_claims where merchant_id=$1 order by field,claim_id",
    [merchantId],
  );
  return rows.rows.map(rowToClaim);
}

export async function setClaimStatus(
  claimId: string,
  status: CanonicalClaim["resolutionStatus"],
  client: DbClient = getPool(),
): Promise<void> {
  await client.query(
    `update canonical_claims set resolution_status = $2 where claim_id = $1`,
    [claimId, status],
  );
}

export async function upsertConflict(
  merchantId: string,
  field: string,
  claimIds: string[],
  client: DbClient = getPool(),
): Promise<string> {
  const result = await client.query<{ conflict_id: string }>(
    `insert into claim_conflicts (merchant_id, field, claim_ids, status)
     values ($1, $2, $3, 'conflicted')
     returning conflict_id`,
    [merchantId, field, claimIds],
  );
  const conflictId = result.rows[0]?.conflict_id;
  if (!conflictId) {
    throw new Error("Failed to create claim_conflicts row");
  }
  return conflictId;
}

export async function resolveConflict(
  conflictId: string,
  resolvedClaimId: string,
  client: DbClient = getPool(),
): Promise<void> {
  await client.query(
    `update claim_conflicts
     set status = 'resolved', resolved_claim_id = $2, resolved_at = now()
     where conflict_id = $1`,
    [conflictId, resolvedClaimId],
  );
}
