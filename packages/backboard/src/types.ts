import { z } from "zod";

/**
 * Merchant Twin identity used to create the Backboard assistant. Boundaries and
 * the "live facts require tools" rule are baked into the system prompt so the
 * assistant never treats its own memory or training data as operational truth.
 */
export interface MerchantIdentity {
  merchantId: string;
  displayName: string;
  specialty: string;
  boundaries: string[];
}

export interface MerchantAssistant {
  merchantId: string;
  assistantId: string;
  model: string;
  systemPrompt: string;
  createdAt: string;
}

export type MerchantDocumentCategory =
  | "service_catalog"
  | "pricing_policy"
  | "equipment_constraints"
  | "materials_policy"
  | "shipping_rules";

export interface MerchantDocument {
  merchantId: string;
  documentId: string;
  fileName: string;
  mimeType: string;
  category: MerchantDocumentCategory;
  /** Bumped whenever the document's content is replaced; drives corpus idempotency. */
  version: number;
  /** When the document's content became/stopped being accurate, not when it was uploaded. */
  sourceTimestamp: string;
  /** Intentionally-outdated fixture used to prove live tool values win over stale RAG output. */
  stale: boolean;
  uploadedAt: string;
}

export interface OrderThread {
  merchantId: string;
  orderId: string;
  threadId: string;
  createdAt: string;
}

export interface MerchantMemoryEntry {
  assistantId: string;
  merchantId: string;
  memoryId: string;
  note: string;
  sourceThreadId?: string;
  recordedAt: string;
}

export interface BackboardModel {
  modelId: string;
  provider: string;
  supportsTools: boolean;
  supportsThinking: boolean;
  supportsJsonOutput: boolean;
  /** B6 item 75 discovery filter: required for a model to satisfy VISION_OPTIONAL. */
  supportsVision: boolean;
  contextWindow: number;
}

export type ToolRiskLevel = "read" | "mutating";

export interface ToolCallContext {
  merchantId: string;
  threadId: string;
  traceId: string;
  orderId?: string;
  actionKey?: string;
}

/**
 * A tool the assistant may invoke. Mutating tools never trust the model for
 * traceId/orderId/actionKey: those come from server-side context, and
 * actionKeyFor must derive a deterministic idempotency key from context and
 * validated arguments rather than the model supplying one.
 */
export interface ToolDefinition<Args = Record<string, unknown>> {
  name: string;
  description: string;
  risk: ToolRiskLevel;
  parameters: z.ZodType<Args>;
  handler: (args: Args, context: ToolCallContext) => Promise<unknown>;
  actionKeyFor?: (args: Args, context: ToolCallContext) => string | undefined;
}

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface SendWithToolsInput<T = unknown> {
  signal?: AbortSignal;
  merchantId: string;
  assistantId: string;
  threadId: string;
  traceId: string;
  message: string;
  orderId?: string;
  tools: ToolDefinition[];
  responseSchema?: z.ZodType<T>;
  maxRounds?: number;
  roundTimeoutMs?: number;
  /**
   * B6 item 76: overrides the assistant's default model for this run only,
   * e.g. with a lane's pinned/discovered model from createModelRouter.
   * Omitting it keeps the assistant's own default model — assistantId and
   * threadId (merchant/order identity) are never affected either way.
   */
  model?: string;
}

export type SendWithToolsFallbackReason =
  | "MALFORMED_OUTPUT"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "MAX_ROUNDS_EXCEEDED"
  | "TOOL_GUARD_REJECTED";

export type SendWithToolsResult<T = unknown> =
  | {
      outcome: "COMPLETED";
      text: string;
      data?: T;
      toolCalls: ToolCallRecord[];
    }
  | {
      outcome: "FALLBACK";
      reason: SendWithToolsFallbackReason;
      text: string;
      toolCalls: ToolCallRecord[];
    };

export interface UploadMerchantDocumentInput {
  merchantId: string;
  assistantId: string;
  fileName: string;
  mimeType: string;
  content: string;
  category: MerchantDocumentCategory;
  version: number;
  sourceTimestamp: string;
  stale?: boolean;
}

export interface RetrieveMerchantDocumentsInput {
  merchantId: string;
  assistantId: string;
  query: string;
  /** "Retrieval depth": max chunks considered; tune after first demo for latency. */
  depth?: number;
}

export interface RetrievedDocumentChunk {
  documentId: string;
  fileName: string;
  category: MerchantDocumentCategory;
  version: number;
  sourceTimestamp: string;
  stale: boolean;
  snippet: string;
  score: number;
}

export interface CreateOrderThreadInput {
  merchantId: string;
  assistantId: string;
  orderId: string;
}

export interface RecordMerchantMemoryInput {
  merchantId: string;
  assistantId: string;
  note: string;
  sourceThreadId?: string;
}

export interface RecallMerchantMemoryInput {
  merchantId: string;
  assistantId: string;
}
