import type {
  BriefClarificationRequest,
  BriefClarificationResult,
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
  clarifyBrief(
    input: BriefClarificationRequest,
  ): Promise<BriefClarificationResult>;
  extractClaims?(input: ClaimExtractionRequest): Promise<ClaimExtractionResult>;
  mintRealtimeClientSecret?(
    safetyIdentifier: string,
    profile?: "desktop",
  ): Promise<RealtimeClientSecret>;
  uploadContext?(input: {
    bytes: Uint8Array;
    name: string;
    mimeType: string;
    traceId: string;
    actionKey: string;
  }): Promise<string>;
}
