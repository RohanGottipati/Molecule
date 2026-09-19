import type {
  BackboardModel,
  CreateOrderThreadInput,
  MerchantAssistant,
  MerchantDocument,
  MerchantIdentity,
  MerchantMemoryEntry,
  OrderThread,
  RecallMerchantMemoryInput,
  RecordMerchantMemoryInput,
  RetrieveMerchantDocumentsInput,
  RetrievedDocumentChunk,
  SendWithToolsInput,
  SendWithToolsResult,
  UploadMerchantDocumentInput,
} from "./types.js";

/**
 * Provider-agnostic Backboard surface. RealBackboardAdapter and
 * MockBackboardAdapter both implement this so callers (the merchant twin
 * service, merchant-agents endpoints) never depend on provider specifics.
 *
 * createOrReuseOrderThread always creates a fresh thread on the provider;
 * "reuse" is a caller-level guarantee enforced by looking up a previously
 * stored threadId (see merchantTwin.ts) before ever calling this method.
 */
export interface BackboardAdapter {
  listModels(): Promise<BackboardModel[]>;
  createMerchantAssistant(
    identity: MerchantIdentity,
  ): Promise<MerchantAssistant>;
  uploadMerchantDocument(
    input: UploadMerchantDocumentInput,
  ): Promise<MerchantDocument>;
  /**
   * B2 RAG retrieval. Never treat the returned snippets as canonical
   * inventory/capacity; cross-check with tools/Reality before acting.
   */
  retrieveMerchantDocuments(
    input: RetrieveMerchantDocumentsInput,
  ): Promise<RetrievedDocumentChunk[]>;
  createOrReuseOrderThread(input: CreateOrderThreadInput): Promise<OrderThread>;
  sendWithTools<T = unknown>(
    input: SendWithToolsInput<T>,
  ): Promise<SendWithToolsResult<T>>;
  recordMerchantMemory(
    input: RecordMerchantMemoryInput,
  ): Promise<MerchantMemoryEntry>;
  recallMerchantMemory(
    input: RecallMerchantMemoryInput,
  ): Promise<MerchantMemoryEntry[]>;
}

export class BackboardApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "BackboardApiError";
  }
}
