import { createHash } from "node:crypto";
import type { CanonicalClaim } from "@molecule/contracts";

import {
  effectId,
  insertClaim,
  listMerchantClaims,
  persistEvent,
  resolveMerchant,
  transaction,
  type DbClient,
} from "@molecule/db";

export { resolveMerchant };

import {
  stableJson,
  toCanonicalClaim,
  type RawClaimInput,
} from "./ingestion.js";
import { resolveMerchantFields, type ResolvedFact } from "./resolution.js";

/**
 * Per-field resolution lives in `@molecule/resolution` so the reservation guard
 * in `@molecule/db` answers "what is true for this merchant" with exactly the
 * same code as candidate search.
 */
export const resolveMerchantClaims = resolveMerchantFields<CanonicalClaim>;

export type { ResolvedFact };

export class ClaimIngestionError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ClaimIngestionError";
  }
}

export async function ingestClaim(
  input: RawClaimInput,
  traceId: string,
  client?: DbClient,
) {
  if (typeof traceId !== "string" || !traceId.trim())
    throw new ClaimIngestionError("traceId is required");
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.merchantId !== "string" ||
    typeof input.field !== "string" ||
    typeof input.sourceReference !== "string" ||
    !input.merchantId.trim() ||
    !input.field.trim() ||
    !input.sourceReference.trim()
  )
    throw new ClaimIngestionError("Invalid claim envelope");
  const raw = stableJson(input);
  const checksum = createHash("sha256").update(raw).digest("hex");
  const artifactId = `artifact:${checksum}`;
  const ingest = async (connection: DbClient) => {
    const merchant = await connection.query(
      "select merchant_id from merchants where merchant_id=$1 for update",
      [input.merchantId],
    );
    if (!merchant.rowCount)
      throw new ClaimIngestionError("Unknown merchant", 404);
    const inserted = await connection.query(
      `insert into raw_artifacts(artifact_id,merchant_id,source_kind,source_reference,checksum,raw_content)
      values($1,$2,$3,$4,$5,$6) on conflict(artifact_id) do nothing returning artifact_id`,
      [
        artifactId,
        input.merchantId,
        input.sourceKind ?? "unknown",
        input.sourceReference,
        checksum,
        raw,
      ],
    );
    const result = toCanonicalClaim({ ...input, sourceChecksum: checksum });
    if (!inserted.rowCount) {
      if (!result.ok) return result;
      const stored = (
        await listMerchantClaims(input.merchantId, connection)
      ).find((claim) => claim.claimId === result.claim.claimId);
      if (!stored) throw new Error("Previously ingested claim was removed");
      return { ok: true as const, claim: stored };
    }
    if (result.ok) {
      await insertClaim(result.claim, connection);
      // A source can publish successive observations of one fact (for example,
      // Shopify inventory for the same inventory item). Keep the full audit
      // trail, but make older observations in that exact source stream
      // ineligible for resolution. A delayed webhook cannot regress a newer
      // fact because the source's observed timestamp decides which stays
      // active; ties remain active and resolve normally as a conflict.
      await connection.query(
        `with source_observations as (
           select claim_id,
                  coalesce(observed_at, ingested_at) as observed_at,
                  max(coalesce(observed_at, ingested_at)) over () as newest_observed_at
           from canonical_claims
           where merchant_id=$1 and field=$2 and source_kind=$3 and source_reference=$4
             and resolution_status in ('active','conflicted')
         )
         update canonical_claims claims set resolution_status='superseded'
         from source_observations observations
         where claims.claim_id=observations.claim_id
           and observations.observed_at < observations.newest_observed_at`,
        [
          result.claim.merchantId,
          result.claim.field,
          result.claim.source.kind,
          result.claim.source.reference,
        ],
      );
    } else {
      if (result.disposition === "needs_review")
        await connection.query(
          `insert into rox_review_queue
             (task_id,kind,merchant_id,field,detail,proposed_action)
           values($1,'quarantine',$2,$3,$4,$5)
           on conflict(task_id) do nothing`,
          [
            `ingest-review:${checksum}`,
            input.merchantId,
            input.field,
            {
              artifactId,
              code: result.code ?? "needs_review",
              reason: result.reason,
              sourceReference: input.sourceReference,
              evidenceText: input.evidenceText ?? null,
            },
            {
              action: "ask_supplier_to_clarify",
              requiresApproval: true,
            },
          ],
        );
      await connection.query(
        "insert into quarantined_claims(quarantine_id,artifact_id,reason) values($1,$2,$3)",
        [artifactId, artifactId, result.reason],
      );
    }
    await persistEvent(
      {
        eventId: effectId(`ingest:${artifactId}`),
        traceId,
        merchantId: input.merchantId,
        eventType: result.ok
          ? "reality.claim.ingested"
          : result.disposition === "needs_review"
            ? "reality.claim.needs_review"
            : "reality.claim.quarantined",
        severity: result.ok ? "INFO" : "WARN",
        source: "rox",
        ts: new Date().toISOString(),
        payload: {
          artifactId,
          checksum,
          field: input.field,
          ...(result.ok
            ? { claimId: result.claim.claimId }
            : {
                reason: result.reason,
                disposition: result.disposition ?? "quarantine",
                code: result.code,
              }),
        },
      },
      connection,
    );
    await resolveMerchant(input.merchantId, traceId, connection);
    if (!result.ok) return result;
    const stored = (
      await listMerchantClaims(input.merchantId, connection)
    ).find((claim) => claim.claimId === result.claim.claimId);
    if (!stored) throw new Error("Ingested claim missing");
    return { ok: true as const, claim: stored };
  };
  return client ? ingest(client) : transaction(ingest);
}
