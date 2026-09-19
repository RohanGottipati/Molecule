export type { BackboardAdapter } from "./BackboardAdapter.js";
export { BackboardApiError } from "./BackboardAdapter.js";
export {
  MockBackboardAdapter,
  type MockDirective,
} from "./MockBackboardAdapter.js";
export {
  RealBackboardAdapter,
  type RealBackboardAdapterConfig,
} from "./RealBackboardAdapter.js";
export {
  InMemoryMerchantAgentRepository,
  type MerchantAgentRepository,
} from "./repository.js";
export {
  createMerchantTwinService,
  type MerchantTwinService,
} from "./merchantTwin.js";
export {
  buildDemoMerchantCorpus,
  type MerchantCorpusDocumentInput,
} from "./merchantCorpus.js";
export {
  retrieveTopDocuments,
  reconcileWithLiveValue,
  DEFAULT_RETRIEVAL_DEPTH,
  type IndexedDocument,
  type ReconciledValue,
  type ReconciledValueSource,
} from "./retrieval.js";
export { buildMerchantSystemPrompt } from "./systemPrompt.js";
export {
  runBoundedToolLoop,
  type ConversationClient,
  type ConverseTurn,
} from "./toolLoop.js";
export * from "./types.js";
