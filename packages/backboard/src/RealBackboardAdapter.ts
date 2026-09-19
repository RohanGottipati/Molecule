import {
  BackboardApiError,
  type BackboardAdapter,
} from "./BackboardAdapter.js";
import { buildMerchantSystemPrompt } from "./systemPrompt.js";
import type { ConversationClient, ConverseTurn } from "./toolLoop.js";
import { runBoundedToolLoop } from "./toolLoop.js";
import type {
  BackboardModel,
  CreateOrderThreadInput,
  MerchantAssistant,
  MerchantDocument,
  MerchantDocumentCategory,
  MerchantIdentity,
  MerchantMemoryEntry,
  OrderThread,
  RecallMerchantMemoryInput,
  RecordMerchantMemoryInput,
  RetrieveMerchantDocumentsInput,
  RetrievedDocumentChunk,
  SendWithToolsInput,
  SendWithToolsResult,
  ToolDefinition,
  UploadMerchantDocumentInput,
} from "./types.js";

export interface RealBackboardAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}

const DEFAULT_BASE_URL = "https://api.backboard.io";
const DEFAULT_POLL_INTERVAL_MS = 200;

// Wire shapes are best-effort against the playbook's own run vocabulary
// (queued/in_progress/requires_action/completed) and B2's retrieval-depth
// language. Confirm field names, including the document search endpoint,
// against Backboard's published API reference before removing this note.
interface ModelWire {
  id: string;
  provider: string;
  supports_tools: boolean;
  supports_thinking: boolean;
  supports_json_output: boolean;
  context_window: number;
}

interface AssistantWire {
  id: string;
  model: string;
}

interface DocumentWire {
  id: string;
  created_at: string;
}

interface DocumentChunkWire {
  document_id: string;
  file_name: string;
  category: MerchantDocumentCategory;
  version: number;
  source_timestamp: string;
  stale: boolean;
  snippet: string;
  score: number;
}

interface ThreadWire {
  id: string;
}

interface ToolCallWire {
  id: string;
  function: { name: string; arguments: string };
}

interface RunWire {
  id: string;
  status:
    | "queued"
    | "in_progress"
    | "requires_action"
    | "completed"
    | "failed"
    | "expired"
    | "cancelled";
  required_action?: { submit_tool_outputs?: { tool_calls: ToolCallWire[] } };
}

interface MessageWire {
  content: { text?: { value: string } }[];
}

interface MemoryWire {
  id: string;
  note: string;
  source_thread_id?: string;
  created_at: string;
}

function toToolSpec(tool: ToolDefinition) {
  return { name: tool.name, description: tool.description };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RealConversationClient implements ConversationClient {
  private runId: string | undefined;

  constructor(
    private readonly request: <T>(
      path: string,
      init?: RequestInit,
    ) => Promise<T>,
    private readonly assistantId: string,
    private readonly threadId: string,
    private readonly tools: ToolDefinition[],
    private readonly pollIntervalMs: number,
  ) {}

  async start(input: { message: string }): Promise<ConverseTurn> {
    await this.request(`/v1/threads/${this.threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: input.message }),
    });
    const run = await this.request<RunWire>(
      `/v1/threads/${this.threadId}/runs`,
      {
        method: "POST",
        body: JSON.stringify({
          assistant_id: this.assistantId,
          tools: this.tools.map(toToolSpec),
        }),
      },
    );
    return this.poll(run);
  }

  async submitToolOutputs(input: {
    toolOutputs: { toolCallId: string; output: string }[];
  }): Promise<ConverseTurn> {
    if (!this.runId) {
      throw new BackboardApiError(
        "submitToolOutputs called before a run started",
        0,
      );
    }
    const run = await this.request<RunWire>(
      `/v1/threads/${this.threadId}/runs/${this.runId}/submit_tool_outputs`,
      {
        method: "POST",
        body: JSON.stringify({
          tool_outputs: input.toolOutputs.map((output) => ({
            tool_call_id: output.toolCallId,
            output: output.output,
          })),
        }),
      },
    );
    return this.poll(run);
  }

  private async poll(initialRun: RunWire): Promise<ConverseTurn> {
    let run = initialRun;
    this.runId = run.id;
    while (run.status === "queued" || run.status === "in_progress") {
      await sleep(this.pollIntervalMs);
      run = await this.request<RunWire>(
        `/v1/threads/${this.threadId}/runs/${run.id}`,
      );
      this.runId = run.id;
    }

    if (run.status === "requires_action") {
      const calls = run.required_action?.submit_tool_outputs?.tool_calls ?? [];
      return {
        status: "requires_action",
        toolCalls: calls.map((call) => ({
          id: call.id,
          name: call.function.name,
          args: JSON.parse(call.function.arguments || "{}") as Record<
            string,
            unknown
          >,
        })),
      };
    }

    if (run.status === "completed") {
      const messages = await this.request<{ data: MessageWire[] }>(
        `/v1/threads/${this.threadId}/messages?limit=1&order=desc`,
      );
      const text = messages.data[0]?.content?.[0]?.text?.value ?? "";
      return { status: "completed", text };
    }

    throw new BackboardApiError(
      `Backboard run ended with status ${run.status}`,
      0,
    );
  }
}

export class RealBackboardAdapter implements BackboardAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;

  constructor(private readonly config: RealBackboardAdapterConfig) {
    if (!config.apiKey) {
      throw new Error("RealBackboardAdapter requires a BACKBOARD_API_KEY");
    }
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
        ...init?.headers,
      },
    });
    if (!response.ok) {
      throw new BackboardApiError(
        `Backboard API ${path} failed with ${response.status}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  async listModels(): Promise<BackboardModel[]> {
    const data = await this.request<{ models: ModelWire[] }>("/v1/models");
    return data.models.map((model) => ({
      modelId: model.id,
      provider: model.provider,
      supportsTools: model.supports_tools,
      supportsThinking: model.supports_thinking,
      supportsJsonOutput: model.supports_json_output,
      contextWindow: model.context_window,
    }));
  }

  async createMerchantAssistant(
    identity: MerchantIdentity,
  ): Promise<MerchantAssistant> {
    const systemPrompt = buildMerchantSystemPrompt(identity);
    const data = await this.request<AssistantWire>("/v1/assistants", {
      method: "POST",
      body: JSON.stringify({
        name: identity.displayName,
        instructions: systemPrompt,
        metadata: { merchantId: identity.merchantId },
      }),
    });
    return {
      merchantId: identity.merchantId,
      assistantId: data.id,
      model: data.model,
      systemPrompt,
      createdAt: new Date().toISOString(),
    };
  }

  async uploadMerchantDocument(
    input: UploadMerchantDocumentInput,
  ): Promise<MerchantDocument> {
    const data = await this.request<DocumentWire>(
      `/v1/assistants/${input.assistantId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          file_name: input.fileName,
          mime_type: input.mimeType,
          content: input.content,
          category: input.category,
          version: input.version,
          source_timestamp: input.sourceTimestamp,
          stale: input.stale ?? false,
        }),
      },
    );
    return {
      merchantId: input.merchantId,
      documentId: data.id,
      fileName: input.fileName,
      mimeType: input.mimeType,
      category: input.category,
      version: input.version,
      sourceTimestamp: input.sourceTimestamp,
      stale: input.stale ?? false,
      uploadedAt: data.created_at,
    };
  }

  async retrieveMerchantDocuments(
    input: RetrieveMerchantDocumentsInput,
  ): Promise<RetrievedDocumentChunk[]> {
    const data = await this.request<{ chunks: DocumentChunkWire[] }>(
      `/v1/assistants/${input.assistantId}/documents/search`,
      {
        method: "POST",
        body: JSON.stringify({ query: input.query, depth: input.depth }),
      },
    );
    return data.chunks.map((chunk) => ({
      documentId: chunk.document_id,
      fileName: chunk.file_name,
      category: chunk.category,
      version: chunk.version,
      sourceTimestamp: chunk.source_timestamp,
      stale: chunk.stale,
      snippet: chunk.snippet,
      score: chunk.score,
    }));
  }

  async createOrReuseOrderThread(
    input: CreateOrderThreadInput,
  ): Promise<OrderThread> {
    const data = await this.request<ThreadWire>("/v1/threads", {
      method: "POST",
      body: JSON.stringify({
        metadata: { merchantId: input.merchantId, orderId: input.orderId },
      }),
    });
    return {
      merchantId: input.merchantId,
      orderId: input.orderId,
      threadId: data.id,
      createdAt: new Date().toISOString(),
    };
  }

  async sendWithTools<T = unknown>(
    input: SendWithToolsInput<T>,
  ): Promise<SendWithToolsResult<T>> {
    const client = new RealConversationClient(
      this.request.bind(this),
      input.assistantId,
      input.threadId,
      input.tools,
      this.pollIntervalMs,
    );
    return runBoundedToolLoop<T>({
      client,
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
      roundTimeoutMs: input.roundTimeoutMs,
    });
  }

  async recordMerchantMemory(
    input: RecordMerchantMemoryInput,
  ): Promise<MerchantMemoryEntry> {
    const data = await this.request<MemoryWire>(
      `/v1/assistants/${input.assistantId}/memory`,
      {
        method: "POST",
        body: JSON.stringify({
          note: input.note,
          source_thread_id: input.sourceThreadId,
        }),
      },
    );
    return {
      assistantId: input.assistantId,
      merchantId: input.merchantId,
      memoryId: data.id,
      note: input.note,
      sourceThreadId: input.sourceThreadId,
      recordedAt: data.created_at,
    };
  }

  async recallMerchantMemory(
    input: RecallMerchantMemoryInput,
  ): Promise<MerchantMemoryEntry[]> {
    const data = await this.request<{ memories: MemoryWire[] }>(
      `/v1/assistants/${input.assistantId}/memory`,
    );
    return data.memories.map((memory) => ({
      assistantId: input.assistantId,
      merchantId: input.merchantId,
      memoryId: memory.id,
      note: memory.note,
      sourceThreadId: memory.source_thread_id,
      recordedAt: memory.created_at,
    }));
  }
}
