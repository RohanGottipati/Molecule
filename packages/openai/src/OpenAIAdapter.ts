import type {
  ClaimExtractionRequest,
  ClaimExtractionResult,
  CompileIntentRequest,
  CompileIntentResult,
} from "@molecule/contracts";

export interface RealtimeClientSecret {
  value: string;
  expiresAt?: number;
}

export interface OpenAIAdapter {
  compileIntent(input: CompileIntentRequest): Promise<CompileIntentResult>;
  extractClaims?(input: ClaimExtractionRequest): Promise<ClaimExtractionResult>;
  mintRealtimeClientSecret?(
    safetyIdentifier: string,
  ): Promise<RealtimeClientSecret>;
}
