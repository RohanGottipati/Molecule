import type { CanonicalClaim } from "@molecule/contracts";
import { stableJson } from "./ingestion.js";

/**
 * Weights are intentionally named constants, not magic numbers, so the
 * demo can explain *why* a claim won (playbook: "keep constants in config
 * so demo can explain them").
 */
export const RESOLUTION_WEIGHTS = {
  authority: 0.35,
  recency: 0.3,
  confidence: 0.25,
  corroboration: 0.1,
};

/** Half-life for recency decay. A claim from this many days ago scores 0.5 on recency. */
const RECENCY_HALF_LIFE_DAYS = 7;

/**
 * Margin the top claim's score must beat the runner-up by to be declared a
 * winner outright. Below this margin, the field stays "conflicted" rather
 * than silently picking a side (docs/CONTRACTS.md: "conflicted/unknown are
 * valid outcomes").
 */
export const CONFLICT_MARGIN_THRESHOLD = 0.08;

export interface ScoredClaim {
  claim: CanonicalClaim;
  score: number;
  recencyScore: number;
}

function recencyScore(claim: CanonicalClaim, now: Date): number {
  const observed = claim.observedAt ?? claim.ingestedAt;
  const ageDays = Math.max(
    0,
    (now.getTime() - new Date(observed).getTime()) / (1000 * 60 * 60 * 24),
  );
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

function corroborationBonus(
  claim: CanonicalClaim,
  allClaims: CanonicalClaim[],
): number {
  const agreeingCount = new Set(
    allClaims
      .filter(
        (other) =>
          other.claimId !== claim.claimId &&
          other.source.reference !== claim.source.reference &&
          other.normalizedUnit === claim.normalizedUnit &&
          stableJson(other.normalizedValue) ===
            stableJson(claim.normalizedValue),
      )
      .map((other) => other.source.reference),
  ).size;
  // Diminishing returns: first corroborating source matters most.
  return agreeingCount === 0 ? 0 : 1 - 1 / (agreeingCount + 1);
}

export function scoreClaim(
  claim: CanonicalClaim,
  allClaims: CanonicalClaim[],
  now: Date = new Date(),
): ScoredClaim {
  const recency = recencyScore(claim, now);
  const score =
    RESOLUTION_WEIGHTS.authority * claim.sourceAuthority +
    RESOLUTION_WEIGHTS.recency * recency +
    RESOLUTION_WEIGHTS.confidence * claim.extractionConfidence +
    RESOLUTION_WEIGHTS.corroboration * corroborationBonus(claim, allClaims);

  return { claim, score, recencyScore: recency };
}

export type ResolutionResult =
  | {
      status: "resolved";
      winner: ScoredClaim;
      losers: ScoredClaim[];
      allScored: ScoredClaim[];
    }
  | {
      status: "conflicted";
      contenders: ScoredClaim[];
      allScored: ScoredClaim[];
    }
  | { status: "unknown" };

/**
 * Resolves the currently-active claims for one merchant/field into a single
 * trusted value, or reports that the field is conflicted / unknown. Never
 * guesses: a close call stays conflicted rather than picking arbitrarily.
 */
export function resolveClaims(
  claims: CanonicalClaim[],
  now: Date = new Date(),
): ResolutionResult {
  const active = claims.filter(
    (c) =>
      (c.resolutionStatus === "active" ||
        c.resolutionStatus === "conflicted") &&
      c.normalizedValue !== undefined &&
      c.normalizedValue !== null,
  );
  if (active.length === 0) {
    return { status: "unknown" };
  }

  const scored = active
    .map((claim) => scoreClaim(claim, active, now))
    .sort(
      (a, b) =>
        b.score - a.score || a.claim.claimId.localeCompare(b.claim.claimId),
    );

  const top = scored[0];
  if (!top) {
    return { status: "unknown" };
  }
  const runnerUp = scored.find(
    (entry) =>
      entry.claim.normalizedUnit !== top.claim.normalizedUnit ||
      stableJson(entry.claim.normalizedValue) !==
        stableJson(top.claim.normalizedValue),
  );
  if (!runnerUp || top.score - runnerUp.score >= CONFLICT_MARGIN_THRESHOLD) {
    return {
      status: "resolved",
      winner: top,
      losers: scored.slice(1),
      allScored: scored,
    };
  }

  return { status: "conflicted", contenders: scored, allScored: scored };
}

export function explainResolution(result: ResolutionResult): string {
  switch (result.status) {
    case "unknown":
      return "No active claims for this field. Status: unknown.";
    case "conflicted": {
      const list = result.contenders
        .map(
          (c) =>
            `${JSON.stringify(c.claim.normalizedValue)} from ${c.claim.source.kind} (score ${c.score.toFixed(2)})`,
        )
        .join("; ");
      return `Conflicted, no claim cleared the ${CONFLICT_MARGIN_THRESHOLD} margin: ${list}.`;
    }
    case "resolved": {
      const w = result.winner;
      return `Resolved to ${JSON.stringify(w.claim.normalizedValue)} from ${w.claim.source.kind} (${w.claim.source.reference}), score ${w.score.toFixed(3)} = ${RESOLUTION_WEIGHTS.authority}*authority(${w.claim.sourceAuthority}) + ${RESOLUTION_WEIGHTS.recency}*recency(${w.recencyScore.toFixed(2)}) + ${RESOLUTION_WEIGHTS.confidence}*confidence(${w.claim.extractionConfidence}).`;
    }
  }
}
