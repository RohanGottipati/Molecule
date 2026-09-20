// Compatibility surface for the ROX pipeline. The implementation lives in the
// shared package so offline evaluation and API ingestion cannot drift.
export {
  PERIOD_DAYS,
  detectQualifiers,
  interpretCapacity,
  resolvePeriod,
  surroundings,
} from "@molecule/resolution";
