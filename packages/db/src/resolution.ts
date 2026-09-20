import {
  resolveMerchantFields,
  stableJson,
  type ResolvedFact,
} from "@molecule/resolution";

import { listMerchantClaims } from "./claims.js";
import type { DbClient } from "./client.js";
import { effectId, persistEvent } from "./operations.js";

export type { ResolvedFact };

/**
 * Resolves every field of a merchant and persists the outcome: claim statuses,
 * `canonical_resolutions`, conflict records, merchant status and one event per
 * changed field.
 *
 * This lives in `@molecule/db` rather than `services/reality` because it only
 * writes database tables, and because seeding and the reservation guard both
 * need it. Claims that are inserted without being resolved leave the system in
 * a state where the marketplace and the reservation guard disagree, which is
 * the bug this consolidation removes.
 */
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
  for (const {
    field,
    fieldClaims,
    result,
    explanation,
    winner,
    fact,
  } of resolveMerchantFields(claims, now)) {
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

/**
 * Resolves every merchant that has claims. Seeding inserts claims with a
 * placeholder `resolution_status`, so without this pass the demo database holds
 * three contradictory capacity claims that nothing has adjudicated.
 */
export async function resolveAllMerchants(
  traceId: string,
  client: DbClient,
  now = new Date(),
): Promise<void> {
  const merchants = await client.query<{ merchant_id: string }>(
    "select distinct merchant_id from canonical_claims order by merchant_id",
  );
  for (const { merchant_id } of merchants.rows)
    await resolveMerchant(merchant_id, traceId, client, now);
}
