export {
  createRealityService,
  realityHealth,
  type RealityService,
} from "./service.js";
export {
  ingestClaim,
  resolveMerchant,
  type ResolvedFact,
} from "./repository.js";
export {
  toCanonicalClaim,
  normalizeValue,
  type RawClaimInput,
} from "./ingestion.js";
export {
  resolveClaims,
  explainResolution,
  RESOLUTION_WEIGHTS,
  CONFLICT_MARGIN_THRESHOLD,
} from "./resolution.js";
export { catalogCandidates, type CatalogCandidateReport } from "./catalog.js";
export { quoteCatalog } from "./catalogQuote.js";
export {
  observeCatalogInventory,
  type CatalogInventoryObservation,
} from "./catalogInventory.js";
export { catalogGallery } from "./catalogGallery.js";
