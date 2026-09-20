/**
 * The single deterministic claim resolver.
 *
 * Both `services/reality` and the ROX pipeline consume this module. They used to
 * carry hand-copied implementations that had already drifted: the ROX copy
 * compared candidate values while ignoring `normalizedUnit`, so "40 units/day"
 * and "40 units/week" looked like agreement instead of a conflict. Unit-aware
 * comparison is the correct behaviour (a unit mismatch is exactly the kind of
 * mess this system exists to catch), so that is what is shared here.
 *
 * LLMs propose; this module certifies. Nothing in here may call a model.
 */

/** Canonical JSON used for value comparison, checksums and signatures. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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
export const RECENCY_HALF_LIFE_DAYS = 7;

/**
 * Margin the top claim's score must beat the runner-up by to be declared a
 * winner outright. Below this margin, the field stays "conflicted" rather
 * than silently picking a side (docs/CONTRACTS.md: "conflicted/unknown are
 * valid outcomes").
 */
export const CONFLICT_MARGIN_THRESHOLD = 0.08;

/**
 * The structural subset of a claim the resolver needs. `CanonicalClaim`
 * satisfies this, and so does a database row passed through `claimFromRow`.
 */
export interface ResolvableClaim {
  claimId: string;
  normalizedValue: unknown;
  normalizedUnit?: string | undefined;
  source: { kind: string; reference: string };
  observedAt?: string | undefined;
  ingestedAt: string;
  sourceAuthority: number;
  extractionConfidence: number;
  resolutionStatus: string;
}

export interface ScoredClaim<T extends ResolvableClaim = ResolvableClaim> {
  claim: T;
  score: number;
  recencyScore: number;
}

function recencyScore(claim: ResolvableClaim, now: Date): number {
  const observed = claim.observedAt ?? claim.ingestedAt;
  const ageDays = Math.max(
    0,
    (now.getTime() - new Date(observed).getTime()) / (1000 * 60 * 60 * 24),
  );
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/** Agreement from a different source is worth more than repetition from the same one. */
function corroborationBonus(
  claim: ResolvableClaim,
  allClaims: readonly ResolvableClaim[],
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

export function scoreClaim<T extends ResolvableClaim>(
  claim: T,
  allClaims: readonly T[],
  now: Date = new Date(),
): ScoredClaim<T> {
  const recency = recencyScore(claim, now);
  const score =
    RESOLUTION_WEIGHTS.authority * claim.sourceAuthority +
    RESOLUTION_WEIGHTS.recency * recency +
    RESOLUTION_WEIGHTS.confidence * claim.extractionConfidence +
    RESOLUTION_WEIGHTS.corroboration * corroborationBonus(claim, allClaims);

  return { claim, score, recencyScore: recency };
}

export type ResolutionResult<T extends ResolvableClaim = ResolvableClaim> =
  | {
      status: "resolved";
      winner: ScoredClaim<T>;
      losers: ScoredClaim<T>[];
      allScored: ScoredClaim<T>[];
    }
  | {
      status: "conflicted";
      contenders: ScoredClaim<T>[];
      allScored: ScoredClaim<T>[];
    }
  | { status: "unknown" };

/**
 * Resolves the currently-active claims for one merchant/field into a single
 * trusted value, or reports that the field is conflicted / unknown. Never
 * guesses: a close call stays conflicted rather than picking arbitrarily.
 */
export function resolveClaims<T extends ResolvableClaim>(
  claims: readonly T[],
  now: Date = new Date(),
): ResolutionResult<T> {
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

export function explainResolution<T extends ResolvableClaim>(
  result: ResolutionResult<T>,
): string {
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

export interface ResolvedFact {
  field: string;
  status: "resolved" | "conflicted" | "unknown";
  value: unknown;
  winningClaimId?: string;
  explanation: string;
}

/** A claim carrying the field it concerns, which per-field resolution needs. */
export interface FieldedClaim extends ResolvableClaim {
  field: string;
}

/**
 * Groups a merchant's claims by field and resolves each field independently.
 *
 * Every consumer that asks "what is true for this merchant right now" must go
 * through here. Reality's candidate search and the reservation guard used to
 * answer that question two different ways: search resolved the claims live,
 * while reservations read the `canonical_resolutions` snapshot. Seeding writes
 * claims without resolutions, so reservations silently saw no limits at all and
 * granted capacity that search had already excluded.
 */
export function resolveMerchantFields<T extends FieldedClaim>(
  claims: readonly T[],
  now: Date = new Date(),
): {
  field: string;
  fieldClaims: T[];
  result: ResolutionResult<T>;
  explanation: string;
  winner: T | undefined;
  fact: ResolvedFact;
}[] {
  const claimsByField = new Map<string, T[]>();
  for (const claim of claims) {
    const entries = claimsByField.get(claim.field) ?? [];
    entries.push(claim);
    claimsByField.set(claim.field, entries);
  }
  return [...claimsByField]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, fieldClaims]) => {
      const result = resolveClaims(
        fieldClaims.map((claim): T => ({
          ...claim,
          // Resolution may reconsider losing sources, but cannot revive an old
          // observation after a newer value from the same source stream arrived.
          resolutionStatus: fieldClaims.some(
            (other) =>
              other.source.kind === claim.source.kind &&
              other.source.reference === claim.source.reference &&
              !["quarantined", "unknown"].includes(other.resolutionStatus) &&
              Date.parse(other.observedAt ?? other.ingestedAt) >
                Date.parse(claim.observedAt ?? claim.ingestedAt),
          )
            ? "superseded"
            : claim.resolutionStatus === "superseded"
              ? "active"
              : claim.resolutionStatus,
        })),
        now,
      );
      const explanation = explainResolution(result);
      const winner =
        result.status === "resolved" ? result.winner.claim : undefined;
      return {
        field,
        fieldClaims,
        result,
        explanation,
        winner,
        fact: {
          field,
          status: result.status,
          value: winner?.normalizedValue,
          winningClaimId: winner?.claimId,
          explanation,
        },
      };
    });
}

/** Shape of a `canonical_claims` row as returned by node-postgres. */
export interface CanonicalClaimRow {
  claim_id: string;
  normalized_value: unknown;
  normalized_unit?: string | null;
  source_kind: string;
  source_reference: string;
  observed_at?: Date | string | null;
  ingested_at: Date | string;
  source_authority: number | string;
  extraction_confidence: number | string;
  resolution_status: string;
}

const iso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * Adapts a snake_case database row to the resolver's input. Numeric columns
 * arrive from node-postgres as strings, so they are coerced explicitly rather
 * than relied on to compare correctly.
 */
export function claimFromRow(
  row: CanonicalClaimRow,
): ResolvableClaim & { row: CanonicalClaimRow } {
  return {
    claimId: String(row.claim_id),
    normalizedValue: row.normalized_value,
    normalizedUnit: row.normalized_unit ?? undefined,
    source: { kind: row.source_kind, reference: row.source_reference },
    observedAt: row.observed_at ? iso(row.observed_at) : undefined,
    ingestedAt: iso(row.ingested_at),
    sourceAuthority: Number(row.source_authority),
    extractionConfidence: Number(row.extraction_confidence),
    resolutionStatus: row.resolution_status,
    row,
  };
}
