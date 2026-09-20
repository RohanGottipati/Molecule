import { z } from "zod";
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
  requestTimeoutMs?: number;
  signal?: AbortSignal;
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

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const memoryIdentity = {
  id: z.string().min(1).optional(),
  memory_id: z.string().min(1).optional(),
  content: z.string().optional(),
  metadata: z.object({ source: z.string().optional() }).nullish(),
};
const memoryWire = z
  .object({
    ...memoryIdentity,
    created_at: timestamp,
  })
  .refine((value) => value.id || value.memory_id);
// Add-memory is documented as an open 201 object. Live responses include
// memory_id and omit created_at; observation time is recorded locally rather
// than inventing a provider historical timestamp.
const memoryCreateWire = z
  .object({
    ...memoryIdentity,
    created_at: timestamp.optional(),
    success: z.boolean().optional(),
    message: z.string().optional(),
  })
  .refine((value) => value.id || value.memory_id);
const messageWire = z.object({
  thread_id: z.string().min(1),
  content: z.string().nullish(),
  message: z.string().nullish(),
  status: z.enum(["COMPLETED", "REQUIRES_ACTION"]),
  tool_calls: z
    .array(
      z.object({
        id: z.string().min(1),
        function: z.object({ name: z.string().min(1), arguments: z.string() }),
      }),
    )
    .nullish(),
});

function parseWire<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new BackboardApiError(
      `Invalid Backboard response (${parsed.error.issues
        .map((issue) => issue.path.join(".") || "root")
        .slice(0, 8)
        .join(",")})`,
      502,
      "INVALID_RESPONSE",
    );
  return parsed.data;
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
      parameters: z.toJSONSchema(tool.parameters),
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
    private readonly jsonOutput: boolean,
  ) {}

  private toConverseTurn(value: unknown): ConverseTurn {
    const data = parseWire(messageWire, value);
    if (data.thread_id !== this.threadId) {
      throw new BackboardApiError(
        "Backboard returned a different thread",
        502,
        "INVALID_RESPONSE",
      );
    }
    if (data.status === "REQUIRES_ACTION") {
      if (!data.tool_calls?.length)
        throw new BackboardApiError(
          "Missing Backboard tool calls",
          502,
          "INVALID_RESPONSE",
        );
      return {
        status: "requires_action",
        toolCalls: (data.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          args: parseWire(
            z.record(z.string(), z.unknown()),
            JSON.parse(call.function.arguments),
          ),
        })),
      };
    }
    if (data.status === "COMPLETED") {
      const text = data.content ?? data.message;
      if (!text)
        throw new BackboardApiError(
          "Missing Backboard content",
          502,
          "INVALID_RESPONSE",
        );
      return { status: "completed", text };
    }
    throw new BackboardApiError(
      `Backboard message ended with status ${data.status}`,
      0,
    );
  }

  async start(input: { message: string }): Promise<ConverseTurn> {
    // json_output is ignored when tools, RAG/documents, or web search are
    // active. Omit empty tools and turn memory off so a schema-backed call
    // can actually request JSON. Canonical notes still travel in `content`.
    const jsonOutput = this.jsonOutput && this.tools.length === 0;
    const data = await this.request<unknown>("/threads/messages", {
      method: "POST",
      body: JSON.stringify({
        content: input.message,
        thread_id: this.threadId,
        assistant_id: this.assistantId,
        llm_provider: this.provider,
        model_name: this.model,
        ...(this.tools.length ? { tools: this.tools.map(toToolSpec) } : {}),
        memory: jsonOutput ? "off" : "Auto",
        stream: false,
        json_output: jsonOutput,
      }),
    });
    return this.toConverseTurn(data);
  }

  async submitToolOutputs(input: {
    toolOutputs: { toolCallId: string; output: string }[];
  }): Promise<ConverseTurn> {
    const data = await this.request<unknown>("/threads/tool-outputs", {
      method: "POST",
      body: JSON.stringify({
        thread_id: this.threadId,
        tool_outputs: input.toolOutputs.map((output) => ({
          tool_call_id: output.toolCallId,
          output: output.output,
        })),
        stream: false,
      }),
    });
    return this.toConverseTurn(data);
  }
}

export class RealBackboardAdapter implements BackboardAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultModel: string;
  private readonly defaultProvider: string;
  private readonly modelProviders = new Map<string, string>();

  constructor(private readonly config: RealBackboardAdapterConfig) {
    if (!config.apiKey) {
      throw new Error("RealBackboardAdapter requires a BACKBOARD_API_KEY");
    }
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL_NAME;
    this.defaultProvider = config.defaultProvider ?? DEFAULT_LLM_PROVIDER;
    if (config.requestTimeoutMs !== undefined && config.requestTimeoutMs <= 0) {
      throw new Error("requestTimeoutMs must be positive");
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.config.requestTimeoutMs ?? 15_000),
      ...(this.config.signal ? [this.config.signal] : []),
      ...(init?.signal ? [init.signal] : []),
    ]);
    try {
      signal.throwIfAborted();
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal,
        headers: {
          ...(init?.body instanceof FormData
            ? {}
            : { "content-type": "application/json" }),
          "x-api-key": this.config.apiKey,
          ...init?.headers,
        },
      });
      if (!response.ok) {
        throw new BackboardApiError(
          `Backboard API failed with ${response.status}`,
          response.status,
        );
      }
      try {
        return (await response.json()) as T;
      } catch {
        signal.throwIfAborted();
        throw new BackboardApiError(
          "Invalid Backboard JSON response",
          502,
          "INVALID_RESPONSE",
        );
      }
    } catch (error) {
      if (signal.aborted) {
        const timedOut =
          signal.reason instanceof Error &&
          signal.reason.name === "TimeoutError";
        throw new BackboardApiError(
          timedOut
            ? "Backboard request timed out"
            : "Backboard request cancelled",
          timedOut ? 504 : 499,
          timedOut ? "TIMEOUT" : "ABORTED",
        );
      }
      if (error instanceof BackboardApiError) throw error;
      throw new BackboardApiError(
        "Backboard network request failed",
        502,
        "NETWORK",
      );
    }
  }

  async listModels(): Promise<BackboardModel[]> {
    const data = parseWire(
      z.object({
        models: z.array(
          z.object({
            name: z.string().min(1),
            provider: z.string().min(1),
            context_limit: z.number().positive(),
            supports_tools: z.boolean(),
            supports_thinking: z.boolean(),
            supports_json_output: z.boolean().nullable(),
            supports_vision: z.boolean().optional(),
          }),
        ),
      }),
      await this.request<unknown>("/models?model_type=llm&limit=200"),
    );
    for (const model of data.models)
      this.modelProviders.set(model.name, model.provider);
    return data.models.map((model) => ({
      modelId: model.name,
      provider: model.provider,
      supportsTools: model.supports_tools,
      supportsThinking: model.supports_thinking,
      // The provider reports null when support is unknown; never advertise it.
      supportsJsonOutput: model.supports_json_output === true,
      supportsVision: model.supports_vision ?? false,
      contextWindow: model.context_limit,
    }));
  }

  async createMerchantAssistant(
    identity: MerchantIdentity,
  ): Promise<MerchantAssistant> {
    const systemPrompt = buildMerchantSystemPrompt(identity);
    const data = parseWire(
      z.object({ assistant_id: z.string().min(1), created_at: timestamp }),
      await this.request<unknown>("/assistants", {
        method: "POST",
        body: JSON.stringify({
          name: identity.displayName,
          system_prompt: systemPrompt,
        }),
      }),
    );
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
    const data = parseWire(
      z.object({ document_id: z.string().min(1), created_at: timestamp }),
      await this.request<unknown>(
        `/assistants/${encodeURIComponent(input.assistantId)}/documents`,
        {
          method: "POST",
          body: form,
        },
      ),
    );
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

  async waitUntilDocumentIndexed(
    documentId: string,
    options?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const intervalMs = options?.intervalMs ?? 2_000;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([
      deadline,
      ...(this.config.signal ? [this.config.signal] : []),
    ]);
    const statusWire = z.object({ status: z.string().min(1) });
    try {
      while (!signal.aborted) {
        const status = parseWire(
          statusWire,
          await this.request<unknown>(
            `/documents/${encodeURIComponent(documentId)}/status`,
          ),
        );
        if (status.status === "indexed" || status.status === "completed")
          return;
        if (status.status === "error")
          throw new BackboardApiError(
            "Backboard document indexing failed",
            502,
            "INVALID_RESPONSE",
          );
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, intervalMs);
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
    } catch (error) {
      if (signal.aborted)
        throw new BackboardApiError(
          "Backboard document indexing timed out",
          504,
          "TIMEOUT",
        );
      throw error;
    }
    throw new BackboardApiError(
      "Backboard document indexing timed out",
      504,
      "TIMEOUT",
    );
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
    const data = parseWire(
      z.object({ thread_id: z.string().min(1), created_at: timestamp }),
      await this.request<unknown>(
        `/assistants/${encodeURIComponent(input.assistantId)}/threads`,
        { method: "POST", body: JSON.stringify({}) },
      ),
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
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    const client = new RealConversationClient(
      <R>(path: string, init?: RequestInit) =>
        this.request<R>(path, { ...init, signal }),
      input.assistantId,
      input.threadId,
      input.tools,
      input.model ?? this.defaultModel,
      this.modelProviders.get(input.model ?? this.defaultModel) ??
        this.defaultProvider,
      input.responseSchema !== undefined,
    );
    try {
      return await runBoundedToolLoop<T>({
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
        signal,
      });
    } finally {
      controller.abort();
    }
  }

  async recordMerchantMemory(
    input: RecordMerchantMemoryInput,
  ): Promise<MerchantMemoryEntry> {
    const data = parseWire(
      memoryCreateWire,
      await this.request<unknown>(
        `/assistants/${encodeURIComponent(input.assistantId)}/memories`,
        {
          method: "POST",
          body: JSON.stringify({
            content: input.note,
            metadata: input.sourceThreadId
              ? { source: input.sourceThreadId }
              : undefined,
          }),
        },
      ),
    );
    return {
      assistantId: input.assistantId,
      merchantId: input.merchantId,
      memoryId: data.memory_id ?? data.id ?? "",
      note: input.note,
      sourceThreadId: input.sourceThreadId,
      recordedAt: data.created_at ?? new Date().toISOString(),
    };
  }

  async recallMerchantMemory(
    input: RecallMerchantMemoryInput,
  ): Promise<MerchantMemoryEntry[]> {
    const data = parseWire(
      z.object({ memories: z.array(memoryWire) }),
      await this.request<unknown>(
        `/assistants/${encodeURIComponent(input.assistantId)}/memories?page_size=100`,
      ),
    );
    return data.memories.map((memory) => ({
      assistantId: input.assistantId,
      merchantId: input.merchantId,
      memoryId: memory.id ?? memory.memory_id ?? "",
      note: parseWire(z.string().min(1), memory.content),
      sourceThreadId: memory.metadata?.source,
      recordedAt: memory.created_at,
    }));
  }
}
