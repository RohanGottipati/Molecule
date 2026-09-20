// Stage 6: resolution. Deterministic and explainable - the model has no vote
// here. Claims are scored on authority, recency, confidence and corroboration;
// if the top two distinct values are within the conflict margin the field stays
// conflicted, which is a valid answer rather than a failure.
//
// The weights mirror services/reality/src/resolution.ts so the Rox pipeline and
// the Reality service cannot disagree about what is true.

import {
  RESOLUTION_WEIGHTS,
  CONFLICT_MARGIN,
  RECENCY_HALF_LIFE_DAYS,
} from "./config.mjs";
import { shortId, stableJson, bumpStage, emitEvent } from "./db.mjs";

export function recencyScore(observedAt, now) {
  const ageDays = Math.max(
    0,
    (now.getTime() - new Date(observedAt).getTime()) / 86400000,
  );
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/** Agreement from a different source is worth more than repetition from the same one. */
export function corroboration(claim, all) {
  const agreeing = new Set(
    all
      .filter(
        (o) =>
          o.claim_id !== claim.claim_id &&
          o.source_reference !== claim.source_reference &&
          stableJson(o.normalized_value) === stableJson(claim.normalized_value),
      )
      .map((o) => o.source_reference),
  ).size;
  return agreeing === 0 ? 0 : 1 - 1 / (agreeing + 1);
}

export function scoreClaims(claims, now = new Date()) {
  return claims
    .map((c) => {
      const recency = recencyScore(c.observed_at ?? c.ingested_at, now);
      const score =
        RESOLUTION_WEIGHTS.authority * Number(c.source_authority) +
        RESOLUTION_WEIGHTS.recency * recency +
        RESOLUTION_WEIGHTS.confidence * Number(c.extraction_confidence) +
        RESOLUTION_WEIGHTS.corroboration * corroboration(c, claims);
      return { claim: c, score, recency };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.claim.claim_id).localeCompare(String(b.claim.claim_id)),
    );
}

export function decide(scored) {
  if (!scored.length) return { status: "unknown" };
  const top = scored[0];
  const runnerUp = scored.find(
    (s) =>
      stableJson(s.claim.normalized_value) !==
      stableJson(top.claim.normalized_value),
  );
  if (!runnerUp || top.score - runnerUp.score >= CONFLICT_MARGIN) {
    return { status: "resolved", winner: top, runnerUp };
  }
  return { status: "conflicted", contenders: [top, runnerUp] };
}

export function explain(decision, scored) {
  if (decision.status === "unknown")
    return "No active claims for this field. Status: unknown.";
  if (decision.status === "conflicted") {
    const list = decision.contenders
      .map(
        (c) =>
          `${JSON.stringify(c.claim.normalized_value)} ${c.claim.normalized_unit ?? ""} from ${c.claim.source_kind} (${c.claim.source_reference}, score ${c.score.toFixed(3)})`,
      )
      .join(" vs ");
    return `Conflicted: no value cleared the ${CONFLICT_MARGIN} margin. ${list}. ${scored.length} active claims.`;
  }
  const w = decision.winner;
  const parts = [
    `${RESOLUTION_WEIGHTS.authority}*authority(${Number(w.claim.source_authority).toFixed(2)})`,
    `${RESOLUTION_WEIGHTS.recency}*recency(${w.recency.toFixed(2)})`,
    `${RESOLUTION_WEIGHTS.confidence}*confidence(${Number(w.claim.extraction_confidence).toFixed(2)})`,
  ].join(" + ");
  const margin = decision.runnerUp
    ? ` Beat ${JSON.stringify(decision.runnerUp.claim.normalized_value)} by ${(w.score - decision.runnerUp.score).toFixed(3)}.`
    : " No competing value.";
  return `Resolved to ${JSON.stringify(w.claim.normalized_value)} ${w.claim.normalized_unit ?? ""} from ${w.claim.source_kind} (${w.claim.source_reference}), score ${w.score.toFixed(3)} = ${parts}.${margin}`;
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
    const scored = scoreClaims(claims, now);
    const decision = decide(scored);
    const explanation = explain(decision, scored);
    const value =
      decision.status === "resolved"
        ? decision.winner.claim.normalized_value
        : null;
    const winner =
      decision.status === "resolved" ? decision.winner.claim.claim_id : null;

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
            claimId: s.claim.claim_id,
            value: s.claim.normalized_value,
            unit: s.claim.normalized_unit,
            source: s.claim.source_kind,
            reference: s.claim.source_reference,
            authority: Number(s.claim.source_authority),
            confidence: Number(s.claim.extraction_confidence),
            recency: Number(s.recency.toFixed(4)),
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
        [decision.contenders.map((c) => c.claim.claim_id)],
      );
      await db.query(
        `insert into claim_conflicts (conflict_id, merchant_id, field, claim_ids, status)
         values ($1,$2,$3,$4,'conflicted')
         on conflict (conflict_id) do update set claim_ids = excluded.claim_ids, status = 'conflicted'`,
        [
          shortId("conflict", merchant_id, field),
          merchant_id,
          field,
          scored.map((s) => s.claim.claim_id),
        ],
      );
      await emitEvent(db, {
        traceId,
        type: "reality.claim.conflicted",
        severity: "WARN",
        merchantId: merchant_id,
        payload: {
          field,
          values: decision.contenders.map((c) => c.claim.normalized_value),
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
