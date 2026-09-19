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
  /**
   * Backboard has no per-assistant model: `POST /threads/messages` takes
   * `llm_provider`/`model_name` per call. This is only the value recorded on
   * MerchantAssistant.model and used when sendWithTools/createModelRouter
   * don't supply a per-run override.
   */
  defaultModel?: string;
  defaultProvider?: string;
}

// Confirmed 2026-09-19 against https://backboard-docs.docsalot.dev (the
// published Backboard API reference). Backboard has no OpenAI-Assistants-style
// run object: POST /threads/messages returns the completion (or a
// REQUIRES_ACTION tool-call request) synchronously in one call, so there is
// no polling loop here.
const DEFAULT_BASE_URL = "https://app.backboard.io/api";
const DEFAULT_MODEL_NAME = "gpt-4o";
const DEFAULT_LLM_PROVIDER = "openai";

interface ModelWire {
  name: string;
  provider: string;
  model_type: string;
  context_limit: number;
  supports_tools: boolean;
  supports_thinking: boolean;
  supports_json_output: boolean;
  supports_vision?: boolean;
}

interface AssistantWire {
  assistant_id: string;
  name: string;
  system_prompt: string | null;
  created_at: string;
}

interface ThreadWire {
  thread_id: string;
  created_at: string;
}

interface ToolCallWire {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface MessageResponseWire {
  message: string;
  thread_id: string;
  content: string | null;
  status: "COMPLETED" | "REQUIRES_ACTION" | string;
  tool_calls: ToolCallWire[] | null;
}

interface DocumentWire {
  document_id: string;
  filename: string;
  status: string;
  created_at: string;
}

interface MemoryWire {
  id?: string;
  memory_id?: string;
  content: string;
  metadata?: { source?: string } | null;
  created_at: string;
}

// OpenAI-style function-tool wire shape Backboard expects in `tools`.
// Parameters are validated locally by runBoundedToolLoop against each
// ToolDefinition's zod schema; the wire spec only needs to name the tool so
// the model knows it exists and how to describe a call for it.
function toToolSpec(tool: ToolDefinition) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { type: "object" },
    },
  };
}

class RealConversationClient implements ConversationClient {
  constructor(
    private readonly request: <T>(
      path: string,
      init?: RequestInit,
    ) => Promise<T>,
    private readonly assistantId: string,
    private readonly threadId: string,
    private readonly tools: ToolDefinition[],
    private readonly model: string,
    private readonly provider: string,
  ) {}

  private toConverseTurn(data: MessageResponseWire): ConverseTurn {
    if (data.status === "REQUIRES_ACTION") {
      return {
        status: "requires_action",
        toolCalls: (data.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          args: JSON.parse(call.function.arguments || "{}") as Record<
            string,
            unknown
          >,
        })),
      };
    }
    if (data.status === "COMPLETED") {
      return { status: "completed", text: data.content ?? data.message ?? "" };
    }
    throw new BackboardApiError(
      `Backboard message ended with status ${data.status}`,
      0,
    );
  }

  async start(input: { message: string }): Promise<ConverseTurn> {
    const data = await this.request<MessageResponseWire>(
      "/threads/messages",
      {
        method: "POST",
        body: JSON.stringify({
          content: input.message,
          thread_id: this.threadId,
          assistant_id: this.assistantId,
          llm_provider: this.provider,
          model_name: this.model,
          tools: this.tools.map(toToolSpec),
          memory: "Auto",
          stream: false,
        }),
      },
    );
    return this.toConverseTurn(data);
  }

  async submitToolOutputs(input: {
    toolOutputs: { toolCallId: string; output: string }[];
  }): Promise<ConverseTurn> {
    const data = await this.request<MessageResponseWire>(
      "/threads/tool-outputs",
      {
        method: "POST",
        body: JSON.stringify({
          thread_id: this.threadId,
          tool_outputs: input.toolOutputs.map((output) => ({
            tool_call_id: output.toolCallId,
            output: output.output,
          })),
          stream: false,
        }),
      },
    );
    return this.toConverseTurn(data);
  }
}

export class RealBackboardAdapter implements BackboardAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultModel: string;
  private readonly defaultProvider: string;

  constructor(private readonly config: RealBackboardAdapterConfig) {
    if (!config.apiKey) {
      throw new Error("RealBackboardAdapter requires a BACKBOARD_API_KEY");
    }
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL_NAME;
    this.defaultProvider = config.defaultProvider ?? DEFAULT_LLM_PROVIDER;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey,
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
    const data = await this.request<{ models: ModelWire[] }>(
      "/models?model_type=llm&limit=200",
    );
    return data.models.map((model) => ({
      modelId: model.name,
      provider: model.provider,
      supportsTools: model.supports_tools,
      supportsThinking: model.supports_thinking,
      supportsJsonOutput: model.supports_json_output,
      supportsVision: model.supports_vision ?? false,
      contextWindow: model.context_limit,
    }));
  }

  async createMerchantAssistant(
    identity: MerchantIdentity,
  ): Promise<MerchantAssistant> {
    const systemPrompt = buildMerchantSystemPrompt(identity);
    const data = await this.request<AssistantWire>("/assistants", {
      method: "POST",
      body: JSON.stringify({
        name: identity.displayName,
        system_prompt: systemPrompt,
      }),
    });
    return {
      merchantId: identity.merchantId,
      assistantId: data.assistant_id,
      model: this.defaultModel,
      systemPrompt,
      createdAt: data.created_at,
    };
  }

  async uploadMerchantDocument(
    input: UploadMerchantDocumentInput,
  ): Promise<MerchantDocument> {
    // Backboard's upload endpoint only accepts a multipart `file` field — no
    // custom metadata. category/version/sourceTimestamp/stale are Molecule's
    // own bookkeeping (see MerchantDocument), echoed from the input rather
    // than round-tripped through the provider.
    const form = new FormData();
    form.append(
      "file",
      new Blob([input.content], { type: input.mimeType }),
      input.fileName,
    );
    const response = await this.fetchImpl(
      `${this.baseUrl}/assistants/${input.assistantId}/documents`,
      {
        method: "POST",
        headers: { "x-api-key": this.config.apiKey },
        body: form,
      },
    );
    if (!response.ok) {
      throw new BackboardApiError(
        `Backboard API /assistants/${input.assistantId}/documents failed with ${response.status}`,
        response.status,
      );
    }
    const data = (await response.json()) as DocumentWire;
    return {
      merchantId: input.merchantId,
      documentId: data.document_id,
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
    _input: RetrieveMerchantDocumentsInput,
  ): Promise<RetrievedDocumentChunk[]> {
    // Backboard has no standalone document-search endpoint (confirmed
    // against the published API reference 2026-09-19): retrieval only
    // happens as the assistant's own internal search_documents tool during
    // POST /threads/messages, and that tool's results surface as
    // retrieved_files (filenames only — no chunk/score/category/version) on
    // the message response, not as a queryable RetrievedDocumentChunk[].
    // This is a real gap between BackboardAdapter's B2 contract and the
    // provider, not a wiring bug — needs a design decision (drop standalone
    // retrieval and read retrieved_files off sendWithTools instead, or keep
    // this unsupported on the real adapter) before this can return real data.
    throw new BackboardApiError(
      "Backboard has no standalone document-search endpoint; retrieveMerchantDocuments is unsupported on RealBackboardAdapter. See the comment on this method.",
      501,
    );
  }

  async createOrReuseOrderThread(
    input: CreateOrderThreadInput,
  ): Promise<OrderThread> {
    const data = await this.request<ThreadWire>(
      `/assistants/${input.assistantId}/threads`,
      { method: "POST", body: JSON.stringify({}) },
    );
    return {
      merchantId: input.merchantId,
      orderId: input.orderId,
      threadId: data.thread_id,
      createdAt: data.created_at,
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
      input.model ?? this.defaultModel,
      this.defaultProvider,
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
      `/assistants/${input.assistantId}/memories`,
      {
        method: "POST",
        body: JSON.stringify({
          content: input.note,
          metadata: input.sourceThreadId
            ? { source: input.sourceThreadId }
            : undefined,
        }),
      },
    );
    return {
      assistantId: input.assistantId,
      merchantId: input.merchantId,
      memoryId: data.memory_id ?? data.id ?? "",
      note: input.note,
      sourceThreadId: input.sourceThreadId,
      recordedAt: data.created_at,
    };
  }

  async recallMerchantMemory(
    input: RecallMerchantMemoryInput,
  ): Promise<MerchantMemoryEntry[]> {
    const data = await this.request<{ memories: MemoryWire[] }>(
      `/assistants/${input.assistantId}/memories?page_size=100`,
    );
    return data.memories.map((memory) => ({
      assistantId: input.assistantId,
      merchantId: input.merchantId,
      memoryId: memory.id ?? memory.memory_id ?? "",
      note: memory.content,
      sourceThreadId: memory.metadata?.source,
      recordedAt: memory.created_at,
    }));
  }
}
