import type { BackboardAdapter } from "./BackboardAdapter.js";
import type { IndexedDocument } from "./retrieval.js";
import { retrieveTopDocuments } from "./retrieval.js";
import { buildMerchantSystemPrompt } from "./systemPrompt.js";
import type { ConversationClient, ConverseTurn } from "./toolLoop.js";
import { runBoundedToolLoop } from "./toolLoop.js";
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
 * Deterministic script directives that stand in for what a real model would
 * decide to do. Tests program a thread's exact behavior with programThread
 * so the bounded tool loop (rounds, guards, timeouts, schema validation) is
 * exercised deterministically without a live model.
 */
export type MockDirective =
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "final"; text: string }
  | { type: "malformed" }
  | { type: "hang" };

const MOCK_MODELS: BackboardModel[] = [
  {
    modelId: "mock-fast-1",
    provider: "mock",
    supportsTools: true,
    supportsThinking: false,
    supportsJsonOutput: true,
    supportsVision: false,
    contextWindow: 32_000,
  },
  {
    modelId: "mock-reasoning-1",
    provider: "mock",
    supportsTools: true,
    supportsThinking: true,
    supportsJsonOutput: true,
    supportsVision: false,
    contextWindow: 128_000,
  },
  {
    modelId: "mock-vision-1",
    provider: "mock",
    supportsTools: true,
    supportsThinking: false,
    supportsJsonOutput: true,
    supportsVision: true,
    contextWindow: 64_000,
  },
];

class MockConversationClient implements ConversationClient {
  private toolCallSeq = 0;

  constructor(private readonly queue: MockDirective[]) {}

  async start(): Promise<ConverseTurn> {
    return this.nextTurn();
  }

  async submitToolOutputs(): Promise<ConverseTurn> {
    return this.nextTurn();
  }

  private async nextTurn(): Promise<ConverseTurn> {
    const directive = this.queue.shift();
    if (!directive) {
      return { status: "completed", text: "" };
    }
    if (directive.type === "hang") {
      return new Promise<ConverseTurn>(() => {
        // Never resolves; the bounded loop's per-round timeout must fire.
      });
    }
    if (directive.type === "malformed") {
      return { status: "unrecognized" };
    }
    if (directive.type === "final") {
      return { status: "completed", text: directive.text };
    }

    return {
      status: "requires_action",
      toolCalls: [
        {
          id: `call_${++this.toolCallSeq}`,
          name: directive.name,
          args: directive.args,
        },
      ],
    };
  }
}

export class MockBackboardAdapter implements BackboardAdapter {
  private readonly assistantsByMerchant = new Map<string, MerchantAssistant>();
  private readonly memoryByAssistant = new Map<string, MerchantMemoryEntry[]>();
  private readonly scriptsByThread = new Map<string, MockDirective[]>();
  private readonly documentsByAssistant = new Map<string, IndexedDocument[]>();
  private idSeq = 0;

  private nextId(prefix: string): string {
    return `${prefix}_${++this.idSeq}`;
  }

  async listModels(): Promise<BackboardModel[]> {
    return MOCK_MODELS;
  }

  async createMerchantAssistant(
    identity: MerchantIdentity,
  ): Promise<MerchantAssistant> {
    const assistant: MerchantAssistant = {
      merchantId: identity.merchantId,
      assistantId: this.nextId("asst"),
      model: MOCK_MODELS[0]!.modelId,
      systemPrompt: buildMerchantSystemPrompt(identity),
      createdAt: new Date().toISOString(),
    };
    this.assistantsByMerchant.set(identity.merchantId, assistant);
    return assistant;
  }

  async uploadMerchantDocument(
    input: UploadMerchantDocumentInput,
  ): Promise<MerchantDocument> {
    const documentId = this.nextId("doc");
    const indexed: IndexedDocument = {
      documentId,
      fileName: input.fileName,
      category: input.category,
      version: input.version,
      sourceTimestamp: input.sourceTimestamp,
      stale: input.stale ?? false,
      content: input.content,
    };
    const existing = this.documentsByAssistant.get(input.assistantId) ?? [];
    existing.push(indexed);
    this.documentsByAssistant.set(input.assistantId, existing);

    return {
      merchantId: input.merchantId,
      documentId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      category: input.category,
      version: input.version,
      sourceTimestamp: input.sourceTimestamp,
      stale: input.stale ?? false,
      uploadedAt: new Date().toISOString(),
    };
  }

  async retrieveMerchantDocuments(
    input: RetrieveMerchantDocumentsInput,
  ): Promise<RetrievedDocumentChunk[]> {
    const documents = this.documentsByAssistant.get(input.assistantId) ?? [];
    return retrieveTopDocuments(input.query, documents, input.depth);
  }

  async createOrReuseOrderThread(
    input: CreateOrderThreadInput,
  ): Promise<OrderThread> {
    return {
      merchantId: input.merchantId,
      orderId: input.orderId,
      threadId: this.nextId("thread"),
      createdAt: new Date().toISOString(),
    };
  }

  /** Test hook: pre-program exactly what the "model" does on a given thread. */
  programThread(threadId: string, directives: MockDirective[]): void {
    this.scriptsByThread.set(threadId, [...directives]);
  }

  async sendWithTools<T = unknown>(
    input: SendWithToolsInput<T>,
  ): Promise<SendWithToolsResult<T>> {
    const queue = this.scriptsByThread.get(input.threadId) ?? [
      { type: "final", text: `mock-ack: ${input.message}` },
    ];
    this.scriptsByThread.delete(input.threadId);

    return runBoundedToolLoop<T>({
      client: new MockConversationClient(queue),
      message: input.message,
      tools: input.tools,
      context: {
        merchantId: input.merchantId,
        threadId: input.threadId,
        orderId: input.orderId,
        traceId: input.traceId,
      },
      responseSchema: input.responseSchema,
      maxRounds: input.maxRounds,
      roundTimeoutMs: input.roundTimeoutMs ?? 200,
    });
  }

  async recordMerchantMemory(
    input: RecordMerchantMemoryInput,
  ): Promise<MerchantMemoryEntry> {
    const entry: MerchantMemoryEntry = {
      assistantId: input.assistantId,
      merchantId: input.merchantId,
      memoryId: this.nextId("mem"),
      note: input.note,
      sourceThreadId: input.sourceThreadId,
      recordedAt: new Date().toISOString(),
    };
    const list = this.memoryByAssistant.get(input.assistantId) ?? [];
    list.push(entry);
    this.memoryByAssistant.set(input.assistantId, list);
    return entry;
  }

  async recallMerchantMemory(
    input: RecallMerchantMemoryInput,
  ): Promise<MerchantMemoryEntry[]> {
    return [...(this.memoryByAssistant.get(input.assistantId) ?? [])];
  }
}
