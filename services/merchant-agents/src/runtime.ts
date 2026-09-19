import {
  BackboardApiError,
  MockBackboardAdapter,
  RealBackboardAdapter,
  createModelRouter,
  retrieveTopDocuments,
  type MerchantAssistant,
  type MerchantCorpusDocumentInput,
  type MerchantIdentity,
  type MerchantMemoryEntry,
  type OrderThread,
  type RealBackboardAdapterConfig,
  type RetrievedDocumentChunk,
} from "@molecule/backboard";
import {
  MerchantMemoryCardEntrySchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
  type MerchantMemoryCardEntry,
  type MoleculeEvent,
  type QuoteRequest,
  type QuoteResponse,
} from "@molecule/contracts";
import { getPool } from "@molecule/db";
import { z } from "zod";
import type { CanonicalDataClient } from "./canonicalDataClient.js";
import {
  actionDigest,
  persistMerchantEvent,
  transaction,
  type MerchantEventSink,
  type MerchantProviderMode,
} from "./database.js";
import { DatabaseMerchantAgentRepository } from "./databaseRepository.js";
import {
  DatabaseCapacityStore,
  DatabaseJobDecisionStore,
} from "./databaseStores.js";
import { groundQuote } from "./groundQuote.js";
import { MerchantQuoteUnavailableError, QuoteProtocolError } from "./quote.js";
import { createMerchantAgentTools } from "./tools.js";

export interface InitializeMerchantInput {
  identity: MerchantIdentity;
  traceId: string;
  documents?: MerchantCorpusDocumentInput[];
  memories?: string[];
}

export interface RecordMerchantRuntimeMemoryInput {
  merchantId: string;
  orderId: string;
  traceId: string;
  note: string;
}

export interface MerchantRuntimeOptions {
  canonicalData: CanonicalDataClient;
  mode?: MerchantProviderMode;
  backboard?: RealBackboardAdapterConfig;
  eventSink?: MerchantEventSink;
  quoteTimeoutMs?: number;
  now?: () => Date;
}

export interface MerchantRuntime {
  readonly mode: MerchantProviderMode;
  readonly label: string;
  readonly repository: DatabaseMerchantAgentRepository;
  readonly capacity: DatabaseCapacityStore;
  readonly jobs: DatabaseJobDecisionStore;
  initialize(input: InitializeMerchantInput): Promise<MerchantAssistant>;
  ensureOrderThread(input: {
    merchantId: string;
    orderId: string;
    traceId: string;
  }): Promise<OrderThread>;
  recordMemory(
    input: RecordMerchantRuntimeMemoryInput,
  ): Promise<MerchantMemoryCardEntry>;
  quote(request: QuoteRequest, signal?: AbortSignal): Promise<QuoteResponse>;
  listMemory(merchantId: string): Promise<MerchantMemoryCardEntry[]>;
  retrieveDocuments(
    merchantId: string,
    query: string,
    depth?: number,
  ): Promise<RetrievedDocumentChunk[]>;
  health(): Promise<{
    mode: MerchantProviderMode;
    label: string;
    database: "ready";
  }>;
  close(): Promise<void>;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createMerchantRuntime(
  options: MerchantRuntimeOptions,
): MerchantRuntime {
  const mode = options.mode ?? (options.backboard ? "live" : "demo");
  if (mode === "live" && !options.backboard)
    throw new Error("Live mode requires explicit Backboard configuration");
  const label =
    mode === "demo"
      ? "Synthetic demo · canonical tools + PostgreSQL memory"
      : "Live Backboard · canonical tools + PostgreSQL memory";
  const repository = new DatabaseMerchantAgentRepository(mode);
  const capacity = new DatabaseCapacityStore(options.eventSink);
  const jobs = new DatabaseJobDecisionStore(options.eventSink);
  const stopped = new AbortController();
  const timeoutMs = options.quoteTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("quoteTimeoutMs must be positive");
  const provider = (signal = stopped.signal) =>
    mode === "live"
      ? new RealBackboardAdapter({
          ...options.backboard!,
          signal: AbortSignal.any([
            stopped.signal,
            signal,
            ...(options.backboard?.signal ? [options.backboard.signal] : []),
          ]),
        })
      : new MockBackboardAdapter();
  const adapter = provider();
  async function emit(events: MoleculeEvent[]): Promise<void> {
    for (const event of events) await options.eventSink?.(event);
  }
  function check(): void {
    stopped.signal.throwIfAborted();
  }

  async function initialize(
    input: InitializeMerchantInput,
  ): Promise<MerchantAssistant> {
    check();
    z.object({
      traceId: z.string().min(1),
      identity: z.object({
        merchantId: z.string().min(1),
        displayName: z.string().min(1),
        specialty: z.string(),
        boundaries: z.array(z.string()),
      }),
    }).parse(input);
    const merchantId = input.identity.merchantId;
    const result = await transaction(
      getPool(),
      `twin:${mode}:${merchantId}`,
      async (client) => {
        const store = new DatabaseMerchantAgentRepository(mode, client);
        const events: MoleculeEvent[] = [];
        let assistant = await store.getAssistant(merchantId);
        if (!assistant) {
          await client.query(
            "insert into merchants(merchant_id,name) values($1,$2) on conflict do nothing",
            [merchantId, input.identity.displayName],
          );
          assistant = await adapter.createMerchantAssistant(input.identity);
          if (mode === "demo")
            assistant.assistantId = `demo-assistant-${actionDigest(merchantId).slice(0, 24)}`;
          await store.saveAssistant(assistant);
          events.push(
            await persistMerchantEvent(client, {
              traceId: input.traceId,
              merchantId,
              eventType: "merchant.twin.initialized",
              payload: {
                mode,
                label,
                assistantId: assistant.assistantId,
                actionKey: `assistant:${mode}:${merchantId}`,
              },
            }),
          );
        }
        const documents = await store.listDocuments(merchantId);
        for (const document of input.documents ?? []) {
          const prior = documents.find(
            (item) =>
              item.category === document.category &&
              item.version === document.version,
          );
          if (prior) {
            const indexed = await store.listIndexedDocuments(merchantId);
            if (
              indexed.find((item) => item.documentId === prior.documentId)
                ?.content !== document.content
            ) {
              throw new Error(
                "Document version already exists with different content",
              );
            }
            continue;
          }
          const uploaded = await adapter.uploadMerchantDocument({
            ...document,
            merchantId,
            assistantId: assistant.assistantId,
          });
          if (mode === "demo")
            uploaded.documentId = `demo-document-${actionDigest([merchantId, document.category, document.version]).slice(0, 24)}`;
          await store.saveDocument(uploaded, document.content);
          documents.push(uploaded);
          events.push(
            await persistMerchantEvent(client, {
              traceId: input.traceId,
              merchantId,
              eventType: "merchant.document.stored",
              payload: {
                mode,
                label,
                documentId: uploaded.documentId,
                category: uploaded.category,
                version: uploaded.version,
                sourceTimestamp: uploaded.sourceTimestamp,
                stale: uploaded.stale,
                actionKey: `document:${mode}:${actionDigest([merchantId, uploaded.category, uploaded.version])}`,
              },
            }),
          );
        }
        for (const note of input.memories ?? []) {
          const entry = await saveMemory(store, assistant, note);
          if (entry)
            events.push(
              await persistMerchantEvent(client, {
                traceId: input.traceId,
                merchantId,
                eventType: "merchant.memory.recorded",
                payload: {
                  mode,
                  label,
                  memoryId: entry.memoryId,
                  actionKey: `memory:${mode}:${actionDigest([merchantId, note])}`,
                },
              }),
            );
        }
        check();
        return { assistant, events };
      },
    );
    await emit(result.events);
    return result.assistant;
  }

  async function saveMemory(
    store: DatabaseMerchantAgentRepository,
    assistant: MerchantAssistant,
    note: string,
    sourceThreadId?: string,
  ): Promise<MerchantMemoryEntry | undefined> {
    z.string().min(1).max(4000).parse(note);
    if (
      (await store.listMemory(assistant.merchantId)).some(
        (entry) => entry.note === note,
      )
    )
      return undefined;
    const entry = await adapter.recordMerchantMemory({
      merchantId: assistant.merchantId,
      assistantId: assistant.assistantId,
      note,
      sourceThreadId,
    });
    if (mode === "demo")
      entry.memoryId = `demo-memory-${actionDigest([assistant.merchantId, note]).slice(0, 24)}`;
    await store.saveMemory(entry);
    return entry;
  }

  async function ensureOrderThread(input: {
    merchantId: string;
    orderId: string;
    traceId: string;
  }): Promise<OrderThread> {
    check();
    z.object({
      merchantId: z.string().min(1),
      orderId: z.string().min(1),
      traceId: z.string().min(1),
    }).parse(input);
    const result = await transaction(
      getPool(),
      `thread:${mode}:${input.merchantId}:${input.orderId}`,
      async (client) => {
        const store = new DatabaseMerchantAgentRepository(mode, client);
        const existing = await store.getThread(input.merchantId, input.orderId);
        if (existing) return { thread: existing, events: [] };
        const assistant = await store.getAssistant(input.merchantId);
        if (!assistant)
          throw new Error("Merchant must be initialized before quoting");
        const thread = await adapter.createOrReuseOrderThread({
          ...input,
          assistantId: assistant.assistantId,
        });
        if (mode === "demo")
          thread.threadId = `demo-thread-${actionDigest([input.merchantId, input.orderId]).slice(0, 24)}`;
        await store.saveThread(thread);
        const event = await persistMerchantEvent(client, {
          traceId: input.traceId,
          merchantId: input.merchantId,
          orderId: input.orderId,
          eventType: "merchant.thread.created",
          payload: {
            mode,
            label,
            threadId: thread.threadId,
            actionKey: `thread:${mode}:${actionDigest([input.merchantId, input.orderId])}`,
          },
        });
        check();
        return { thread, events: [event] };
      },
    );
    await emit(result.events);
    return result.thread;
  }

  async function listMemory(
    merchantId: string,
  ): Promise<MerchantMemoryCardEntry[]> {
    check();
    return (await repository.listMemory(merchantId)).map((entry) =>
      MerchantMemoryCardEntrySchema.parse(entry),
    );
  }

  async function recordMemory(
    input: RecordMerchantRuntimeMemoryInput,
  ): Promise<MerchantMemoryCardEntry> {
    const thread = await ensureOrderThread(input);
    const result = await transaction(
      getPool(),
      `twin:${mode}:${input.merchantId}`,
      async (client) => {
        const store = new DatabaseMerchantAgentRepository(mode, client);
        const assistant = await store.getAssistant(input.merchantId);
        if (!assistant) throw new Error("Merchant must be initialized");
        const created = await saveMemory(
          store,
          assistant,
          input.note,
          thread.threadId,
        );
        const entry =
          created ??
          (await store.listMemory(input.merchantId)).find(
            (item) => item.note === input.note,
          )!;
        const events = created
          ? [
              await persistMerchantEvent(client, {
                traceId: input.traceId,
                merchantId: input.merchantId,
                orderId: input.orderId,
                eventType: "merchant.memory.recorded",
                payload: {
                  mode,
                  label,
                  memoryId: entry.memoryId,
                  sourceThreadId: thread.threadId,
                  actionKey: `memory:${mode}:${actionDigest([input.merchantId, input.note])}`,
                },
              }),
            ]
          : [];
        check();
        return { entry, events };
      },
    );
    await emit(result.events);
    return MerchantMemoryCardEntrySchema.parse(result.entry);
  }

  async function quote(
    input: QuoteRequest,
    signal?: AbortSignal,
  ): Promise<QuoteResponse> {
    check();
    const request = QuoteRequestSchema.parse(input);
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([
      stopped.signal,
      deadline,
      ...(signal ? [signal] : []),
    ]);
    const run = async () => {
      combined.throwIfAborted();
      if (request.actionKey) {
        const prior = await getPool().query<{
          mode: MerchantProviderMode;
          request: QuoteRequest;
          response: unknown;
        }>(
          "select mode,request,response from merchant_twin_quotes where action_key=$1",
          [request.actionKey],
        );
        combined.throwIfAborted();
        if (prior.rows[0]) {
          if (
            prior.rows[0].mode !== mode ||
            actionDigest(prior.rows[0].request) !== actionDigest(request)
          )
            throw new Error(
              "Quote actionKey conflicts with an existing request",
            );
          return {
            response: QuoteResponseSchema.parse(prior.rows[0].response),
            events: [],
          };
        }
      }
      const thread = await ensureOrderThread(request);
      combined.throwIfAborted();
      const pendingEvents: Parameters<typeof persistMerchantEvent>[1][] = [];
      const assistant = await repository.getAssistant(request.merchantId);
      if (!assistant) throw new Error("Merchant must be initialized");
      const memory = await repository.listMemory(request.merchantId);
      const context = {
        merchantId: request.merchantId,
        orderId: request.orderId,
        traceId: request.traceId,
        threadId: thread.threadId,
      };
      const tools = createMerchantAgentTools({
        canonicalData: options.canonicalData,
        capacity,
        jobs,
      })
        .filter((tool) => tool.risk === "read")
        .map((tool) => ({
          ...tool,
          handler: async (args: Record<string, unknown>) => {
            combined.throwIfAborted();
            if (
              args.capabilityId !== undefined &&
              args.capabilityId !== request.capabilityId
            )
              throw new Error("Tool capability switch rejected");
            return abortable(tool.handler(args, context), combined);
          },
        }));
      const grounded = await groundQuote(
        request,
        tools,
        context,
        options.now?.() ?? new Date(),
        combined,
      );
      let response = grounded.quote;
      if (mode === "live") {
        const live = provider(combined);
        const router = createModelRouter(live);
        const { selection, event: selectionEvent } = await router.selectModel({
          task: {
            kind: request.deadline
              ? "deadline_guarantee"
              : "low_stakes_inventory",
          },
          ...context,
        });
        pendingEvents.push({
          traceId: request.traceId,
          merchantId: request.merchantId,
          orderId: request.orderId,
          eventType: selectionEvent.eventType,
          payload: selectionEvent.payload,
        });
        let candidate: QuoteResponse | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await live.sendWithTools({
            ...context,
            assistantId: assistant.assistantId,
            model: selection.modelId,
            signal: combined,
            tools,
            responseSchema: QuoteResponseSchema,
            message: JSON.stringify({
              instruction:
                "Return only a QuoteResponse JSON object. This is advisory: never reserve or accept a job. Canonical facts override memories. No hidden reasoning.",
              request: { ...request, hold: false },
              canonicalQuote: grounded.quote,
              memory: memory.map(({ note, recordedAt }) => ({
                note,
                recordedAt,
              })),
              repair: attempt > 0,
            }),
          });
          if (result.outcome === "FALLBACK") {
            if (result.reason === "MALFORMED_OUTPUT") continue;
            throw new MerchantQuoteUnavailableError(
              request.merchantId,
              result.reason,
            );
          }
          candidate = result.data;
          if (
            candidate?.status === "COUNTEROFFER" &&
            candidate.requiredChanges.length === 0
          )
            candidate = undefined;
          if (candidate) break;
        }
        if (
          !candidate ||
          candidate.merchantId !== request.merchantId ||
          candidate.capabilityId !== request.capabilityId
        ) {
          throw new QuoteProtocolError(
            "Provider returned invalid quote identity or output",
            request.merchantId,
          );
        }
        if (candidate.status === "CAN_ACCEPT") response = grounded.quote;
        else response = { ...candidate, reservationId: undefined };
        if (grounded.quote.status === "DECLINE") response = grounded.quote;
      }
      response = QuoteResponseSchema.parse({
        ...response,
        reservationId: undefined,
        explanation:
          `${mode === "demo" ? "[Synthetic demo] " : "[Live Backboard] "}${response.explanation}`.slice(
            0,
            600,
          ),
      });
      combined.throwIfAborted();
      const actionKey =
        request.actionKey ??
        `quote:${mode}:${actionDigest([request, response])}`;
      return transaction(getPool(), `quote:${actionKey}`, async (client) => {
        combined.throwIfAborted();
        const stored = await client.query(
          `insert into merchant_twin_quotes(action_key,merchant_id,order_id,intent_version,mode,request,response)
           values($1,$2,$3,$4,$5,$6,$7) on conflict(action_key) do nothing`,
          [
            actionKey,
            request.merchantId,
            request.orderId,
            request.intentVersion,
            mode,
            request,
            response,
          ],
        );
        if (!stored.rowCount) {
          const prior = await client.query<{ response: unknown }>(
            `select response from merchant_twin_quotes
               where action_key=$1 and request=$2::jsonb and mode=$3`,
            [actionKey, JSON.stringify(request), mode],
          );
          combined.throwIfAborted();
          if (!prior.rows[0])
            throw new Error(
              "Quote actionKey conflicts with an existing request",
            );
          return {
            response: QuoteResponseSchema.parse(prior.rows[0].response),
            events: [],
          };
        }
        const events: MoleculeEvent[] = [];
        for (const pending of pendingEvents)
          events.push(await persistMerchantEvent(client, pending));
        const event = await persistMerchantEvent(client, {
          traceId: request.traceId,
          merchantId: request.merchantId,
          orderId: request.orderId,
          eventType: "merchant.quote.completed",
          payload: {
            mode,
            label,
            intentVersion: request.intentVersion,
            status: response.status,
            capabilityId: request.capabilityId,
            actionKey,
            canonicalTools: grounded.evidence,
            memoryIds: memory.map((entry) => entry.memoryId),
            advisory: true,
          },
        });
        combined.throwIfAborted();
        events.push(event);
        return { response, events };
      });
    };
    try {
      const result = await abortable(run(), combined);
      await abortable(emit(result.events), combined);
      return result.response;
    } catch (error) {
      if (combined.aborted)
        throw new MerchantQuoteUnavailableError(request.merchantId, "TIMEOUT");
      if (error instanceof BackboardApiError)
        throw new MerchantQuoteUnavailableError(
          request.merchantId,
          error.code === "TIMEOUT" || error.code === "ABORTED"
            ? "TIMEOUT"
            : "PROVIDER_ERROR",
        );
      throw error;
    }
  }

  return {
    mode,
    label,
    repository,
    capacity,
    jobs,
    initialize,
    ensureOrderThread,
    recordMemory,
    quote,
    listMemory,
    async retrieveDocuments(merchantId, query, depth) {
      check();
      return retrieveTopDocuments(
        query,
        await repository.listIndexedDocuments(merchantId),
        depth,
      );
    },
    async health() {
      check();
      await getPool().query("select 1 from merchant_twin_assistants limit 0");
      return { mode, label, database: "ready" };
    },
    async close() {
      stopped.abort(new Error("Merchant runtime closed"));
    },
  };
}
