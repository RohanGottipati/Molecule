// Stage 6: resolution. Deterministic and explainable - the model has no vote
// here. Claims are scored on authority, recency, confidence and corroboration;
// if the top two distinct values are within the conflict margin the field stays
// conflicted, which is a valid answer rather than a failure.
//
// The scoring itself lives in @molecule/resolution and is the same code the
// Reality service runs. This file used to carry a hand-copied implementation
// that had already drifted: it compared candidate values while ignoring the
// unit, so "40 units/day" and "40 units/week" were treated as corroboration.
// Do not reintroduce a local copy.

import {
  CONFLICT_MARGIN_THRESHOLD,
  RESOLUTION_WEIGHTS,
  claimFromRow,
  resolveClaims,
} from "@molecule/resolution";
import { shortId, stableJson, bumpStage, emitEvent } from "./db.mjs";

/**
 * Rox keeps its own wording because the report and review queue quote it, but
 * it explains the shared resolver's decision rather than recomputing one.
 */
export function explain(result) {
  if (result.status === "unknown")
    return "No active claims for this field. Status: unknown.";
  const describe = (entry) =>
    `${JSON.stringify(entry.claim.normalizedValue)} ${entry.claim.normalizedUnit ?? ""} from ${entry.claim.source.kind} (${entry.claim.source.reference}, score ${entry.score.toFixed(3)})`;
  if (result.status === "conflicted") {
    return `Conflicted: no value cleared the ${CONFLICT_MARGIN_THRESHOLD} margin. ${result.contenders
      .map(describe)
      .join(" vs ")}. ${result.allScored.length} active claims.`;
  }
  const w = result.winner;
  const parts = [
    `${RESOLUTION_WEIGHTS.authority}*authority(${w.claim.sourceAuthority.toFixed(2)})`,
    `${RESOLUTION_WEIGHTS.recency}*recency(${w.recencyScore.toFixed(2)})`,
    `${RESOLUTION_WEIGHTS.confidence}*confidence(${w.claim.extractionConfidence.toFixed(2)})`,
  ].join(" + ");
  const runnerUp = result.losers.find(
    (entry) =>
      entry.claim.normalizedUnit !== w.claim.normalizedUnit ||
      stableJson(entry.claim.normalizedValue) !==
        stableJson(w.claim.normalizedValue),
  );
  const margin = runnerUp
    ? ` Beat ${JSON.stringify(runnerUp.claim.normalizedValue)} by ${(w.score - runnerUp.score).toFixed(3)}.`
    : " No competing value.";
  return `Resolved to ${JSON.stringify(w.claim.normalizedValue)} ${w.claim.normalizedUnit ?? ""} from ${w.claim.source.kind} (${w.claim.source.reference}), score ${w.score.toFixed(3)} = ${parts}.${margin}`;
}

export async function resolve(db, { runId, traceId, all = false }) {
  const counts = {
    fields: 0,
    resolved: 0,
    conflicted: 0,
    unknown: 0,
    changed: 0,
  };
  const now = new Date();

  // Fields this run touched, unless asked for a full re-resolution.
  const { rows: fields } = await db.query(
    all
      ? `select distinct merchant_id, field from canonical_claims where resolution_status in ('active','conflicted')`
      : `select distinct c.merchant_id, c.field
           from canonical_claims c
          where c.resolution_status in ('active','conflicted')
            and exists (select 1 from rox_extractions x where x.run_id = $1 and x.claim_id = c.claim_id)`,
    all ? [] : [runId],
  );

  for (const { merchant_id, field } of fields) {
    counts.fields += 1;
    const { rows: claims } = await db.query(
      `select * from canonical_claims
        where merchant_id = $1 and field = $2 and resolution_status in ('active','conflicted')`,
      [merchant_id, field],
    );
    const decision = resolveClaims(claims.map(claimFromRow), now);
    const scored = decision.status === "unknown" ? [] : decision.allScored;
    const explanation = explain(decision);
    const value =
      decision.status === "resolved"
        ? decision.winner.claim.normalizedValue
        : null;
    const winner =
      decision.status === "resolved" ? decision.winner.claim.claimId : null;

    const { rows: before } = await db.query(
      `select status, value from canonical_resolutions where merchant_id = $1 and field = $2`,
      [merchant_id, field],
    );
    await db.query(
      `insert into canonical_resolutions (merchant_id, field, status, winning_claim_id, value, explanation, scores, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7, now())
       on conflict (merchant_id, field) do update
         set status = excluded.status, winning_claim_id = excluded.winning_claim_id, value = excluded.value,
             explanation = excluded.explanation, scores = excluded.scores, updated_at = now()`,
      [
        merchant_id,
        field,
        decision.status,
        winner,
        value === null ? null : JSON.stringify(value),
        explanation,
        JSON.stringify(
          scored.map((s) => ({
            claimId: s.claim.claimId,
            value: s.claim.normalizedValue,
            unit: s.claim.normalizedUnit ?? null,
            source: s.claim.source.kind,
            reference: s.claim.source.reference,
            authority: s.claim.sourceAuthority,
            confidence: s.claim.extractionConfidence,
            recency: Number(s.recencyScore.toFixed(4)),
            score: Number(s.score.toFixed(4)),
          })),
        ),
      ],
    );

    if (
      !before[0] ||
      before[0].status !== decision.status ||
      stableJson(before[0].value) !== stableJson(value)
    )
      counts.changed += 1;
    counts[decision.status] += 1;

    if (decision.status === "conflicted") {
      // Conflicted claims are marked so the next resolution still sees them.
      await db.query(
        `update canonical_claims set resolution_status = 'conflicted'
          where claim_id = any($1::text[]) and resolution_status = 'active'`,
        [decision.contenders.map((c) => c.claim.claimId)],
      );
      await db.query(
        `insert into claim_conflicts (conflict_id, merchant_id, field, claim_ids, status)
         values ($1,$2,$3,$4,'conflicted')
         on conflict (conflict_id) do update set claim_ids = excluded.claim_ids, status = 'conflicted'`,
        [
          shortId("conflict", merchant_id, field),
          merchant_id,
          field,
          scored.map((s) => s.claim.claimId),
        ],
      );
      await emitEvent(db, {
        traceId,
        type: "reality.claim.conflicted",
        severity: "WARN",
        merchantId: merchant_id,
        payload: {
          field,
          values: decision.contenders.map((c) => c.claim.normalizedValue),
        },
      });
    } else if (decision.status === "resolved") {
      await db.query(
        `update claim_conflicts set status = 'resolved', resolved_claim_id = $3, resolved_at = now()
          where merchant_id = $1 and field = $2 and status = 'conflicted'`,
        [merchant_id, field, winner],
      );
      await emitEvent(db, {
        traceId,
        type: "reality.claim.resolved",
        merchantId: merchant_id,
        payload: { field, value, claimId: winner },
      });
    }
  }

  await bumpStage(db, runId, "resolve", counts);
  await emitEvent(db, {
    traceId,
    type: "rox.resolve.completed",
    payload: counts,
  });
  return counts;
}
