import { createHash } from "node:crypto";

import {
  effectId,
  insertClaim,
  listMerchantClaims,
  persistEvent,
  transaction,
  type DbClient,
} from "@molecule/db";

import {
  stableJson,
  toCanonicalClaim,
  type RawClaimInput,
} from "./ingestion.js";
import { explainResolution, resolveClaims } from "./resolution.js";

export interface ResolvedFact {
  field: string;
  status: "resolved" | "conflicted" | "unknown";
  value: unknown;
  winningClaimId?: string;
  explanation: string;
}

export class ClaimIngestionError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ClaimIngestionError";
  }
}

export async function resolveMerchant(
  merchantId: string,
  traceId: string,
  client: DbClient,
  now = new Date(),
): Promise<ResolvedFact[]> {
  await client.query(
    "select merchant_id from merchants where merchant_id=$1 for update",
    [merchantId],
  );
  const claims = await listMerchantClaims(merchantId, client);
  const facts: ResolvedFact[] = [];
  for (const field of [...new Set(claims.map((claim) => claim.field))].sort()) {
    const fieldClaims = claims.filter((claim) => claim.field === field);
    const result = resolveClaims(
      fieldClaims.map((claim) => ({
        ...claim,
        resolutionStatus:
          claim.resolutionStatus === "superseded"
            ? "active"
            : claim.resolutionStatus,
      })),
      now,
    );
    const explanation = explainResolution(result);
    const winner =
      result.status === "resolved" ? result.winner.claim : undefined;
    const fact: ResolvedFact = {
      field,
      status: result.status,
      value: winner?.normalizedValue,
      winningClaimId: winner?.claimId,
      explanation,
    };
    facts.push(fact);
    const signature = stableJson({
      status: result.status,
      winner: winner?.claimId,
      value: winner?.normalizedValue,
      claims: fieldClaims.map((claim) => claim.claimId).sort(),
    });
    const previous = await client.query<{ signature: string }>(
      "select scores->>'signature' as signature from canonical_resolutions where merchant_id=$1 and field=$2",
      [merchantId, field],
    );
    if (field === "status") {
      const status =
        result.status === "resolved" &&
        (winner?.normalizedValue === "online" ||
          winner?.normalizedValue === "offline")
          ? winner.normalizedValue
          : "unknown";
      await client.query(
        "update merchants set status=$2,updated_at=now() where merchant_id=$1 and status is distinct from $2",
        [merchantId, status],
      );
    }
    if (previous.rows[0]?.signature === signature) continue;
    if (result.status !== "unknown") {
      for (const entry of result.allScored) {
        await client.query(
          "update canonical_claims set resolution_status=$2 where claim_id=$1",
          [
            entry.claim.claimId,
            result.status === "conflicted"
              ? "conflicted"
              : entry.claim.claimId === winner?.claimId
                ? "active"
                : "superseded",
          ],
        );
      }
    }
    await client.query(
      `update claim_conflicts set status='resolved',resolved_claim_id=$3,resolved_at=now()
      where merchant_id=$1 and field=$2 and status='conflicted'`,
      [merchantId, field, winner?.claimId ?? null],
    );
    if (result.status === "conflicted") {
      await client.query(
        `insert into claim_conflicts(merchant_id,field,claim_ids) values($1,$2,$3)`,
        [
          merchantId,
          field,
          result.contenders.map((entry) => entry.claim.claimId),
        ],
      );
    }
    await client.query(
      `insert into canonical_resolutions(merchant_id,field,status,winning_claim_id,value,explanation,scores)
      values($1,$2,$3,$4,$5,$6,$7) on conflict(merchant_id,field) do update set
      status=excluded.status,winning_claim_id=excluded.winning_claim_id,value=excluded.value,
      explanation=excluded.explanation,scores=excluded.scores,updated_at=now()`,
      [
        merchantId,
        field,
        result.status,
        winner?.claimId ?? null,
        JSON.stringify(winner?.normalizedValue ?? null),
        explanation,
        JSON.stringify({
          signature,
          claims:
            result.status === "unknown"
              ? []
              : result.allScored.map((entry) => ({
                  claimId: entry.claim.claimId,
                  score: entry.score,
                  recencyScore: entry.recencyScore,
                })),
        }),
      ],
    );
    await persistEvent(
      {
        eventId: effectId(
          `resolution:${merchantId}:${field}:${signature}:${now.toISOString()}:${traceId}`,
        ),
        traceId,
        merchantId,
        eventType: `reality.claim.${result.status}`,
        severity: result.status === "resolved" ? "INFO" : "WARN",
        source: "rox",
        ts: now.toISOString(),
        payload: {
          field,
          status: result.status,
          value: winner?.normalizedValue,
          winningClaimId: winner?.claimId,
          explanation,
        },
      },
      client,
    );
  }
  return facts;
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
    } else
      await connection.query(
        "insert into quarantined_claims(quarantine_id,artifact_id,reason) values($1,$2,$3)",
        [artifactId, artifactId, result.reason],
      );
    await persistEvent(
      {
        eventId: effectId(`ingest:${artifactId}`),
        traceId,
        merchantId: input.merchantId,
        eventType: result.ok
          ? "reality.claim.ingested"
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
            : { reason: result.reason }),
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
