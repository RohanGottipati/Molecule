import type {
  CandidateCapability,
  CompileIntentRequest,
  CompileIntentResult,
  ExecutionReceipt,
  ProductIntent,
  ProductionPlan,
  QuoteRequest,
  QuoteResponse,
  SolverInput,
} from "@molecule/contracts";

export interface OpenAIClient {
  compileIntent(input: CompileIntentRequest): Promise<CompileIntentResult>;
  mintRealtimeClientSecret?(
    safetyIdentifier: string,
  ): Promise<{ value: string; expiresAt?: number }>;
}

export interface RealityClient {
  searchCandidates(
    intent: ProductIntent,
    excludedMerchantIds?: string[],
  ): Promise<CandidateCapability[]>;
}

export interface MerchantAgentClient {
  quote(request: QuoteRequest, signal?: AbortSignal): Promise<QuoteResponse>;
}

export interface SolverClient {
  solve(input: SolverInput): Promise<ProductionPlan>;
}

export interface ShopifyClient {
  commit(plan: ProductionPlan, traceId: string): Promise<ExecutionReceipt>;
}
