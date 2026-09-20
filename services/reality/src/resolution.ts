/**
 * Reality consumes the shared resolver in `@molecule/resolution`. This file is
 * kept as the local entry point so existing imports keep working, but it must
 * not grow a second implementation: the ROX pipeline scores claims with the
 * same module, and the two drifted apart last time they were separate copies.
 */
export {
  CONFLICT_MARGIN_THRESHOLD,
  RECENCY_HALF_LIFE_DAYS,
  RESOLUTION_WEIGHTS,
  explainResolution,
  resolveClaims,
  resolveMerchantFields,
  scoreClaim,
  stableJson,
  type ResolutionResult,
  type ResolvedFact,
  type ScoredClaim,
} from "@molecule/resolution";
