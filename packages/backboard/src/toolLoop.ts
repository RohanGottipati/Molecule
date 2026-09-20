import type { z } from "zod";

import { BackboardApiError } from "./BackboardAdapter.js";
import type {
  SendWithToolsFallbackReason,
  SendWithToolsResult,
  ToolCallContext,
  ToolCallRecord,
  ToolDefinition,
} from "./types.js";

export interface ConverseTurnRequiresAction {
  status: "requires_action";
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
}

export interface ConverseTurnCompleted {
  status: "completed";
  text: string;
}

export type ConverseTurn =
  ConverseTurnRequiresAction | ConverseTurnCompleted | { status: string };

/**
 * Low-level provider primitive the bounded loop drives. Each adapter
 * implements this against its own transport (mock queue, real HTTP run
 * polling) while the loop itself — rounds, timeouts, tool guards, schema
 * validation — is shared and provider-independent.
 */
export interface ConversationClient {
  start(input: { message: string }): Promise<ConverseTurn>;
  submitToolOutputs(input: {
    toolOutputs: { toolCallId: string; output: string }[];
  }): Promise<ConverseTurn>;
}

export interface RunBoundedToolLoopParams<T> {
  signal?: AbortSignal;
  client: ConversationClient;
  message: string;
  tools: ToolDefinition[];
  context: ToolCallContext;
  responseSchema?: z.ZodType<T>;
  maxRounds?: number;
  roundTimeoutMs?: number;
}

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_ROUND_TIMEOUT_MS = 15_000;

class TimeoutError extends Error {}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new TimeoutError("round cancelled"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new TimeoutError("round timed out"));
    }, timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function fallbackText(reason: SendWithToolsFallbackReason): string {
  switch (reason) {
    case "MALFORMED_OUTPUT":
      return "The merchant assistant returned an output that could not be validated. Treat this response as non-binding.";
    case "TIMEOUT":
      return "The merchant assistant did not respond in time. Treat this response as non-binding.";
    case "PROVIDER_ERROR":
      return "The merchant assistant provider returned an error. Treat this response as non-binding.";
    case "MAX_ROUNDS_EXCEEDED":
      return "The merchant assistant exceeded the bounded tool-call round limit. Treat this response as non-binding.";
    case "TOOL_GUARD_REJECTED":
      return "A mutating tool call was rejected because it lacked required order context. Treat this response as non-binding.";
  }
}

function fallback<T>(
  reason: SendWithToolsFallbackReason,
  toolCalls: ToolCallRecord[],
): SendWithToolsResult<T> {
  return { outcome: "FALLBACK", reason, text: fallbackText(reason), toolCalls };
}

function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* Live completions sometimes wrap the object in prose or a fence. */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* continue */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start)
    return JSON.parse(trimmed.slice(start, end + 1));
  throw new SyntaxError("Merchant assistant output was not JSON");
}

function finalize<T>(
  text: string,
  toolCalls: ToolCallRecord[],
  responseSchema?: z.ZodType<T>,
): SendWithToolsResult<T> {
  if (!responseSchema) {
    return { outcome: "COMPLETED", text, toolCalls };
  }
  let candidate: unknown;
  try {
    candidate = parseJsonPayload(text);
  } catch {
    return fallback("MALFORMED_OUTPUT", toolCalls);
  }
  const parsed = responseSchema.safeParse(candidate);
  if (!parsed.success) {
    return fallback("MALFORMED_OUTPUT", toolCalls);
  }
  return { outcome: "COMPLETED", text, data: parsed.data, toolCalls };
}

async function callClient<T>(
  promise: Promise<ConverseTurn>,
  timeoutMs: number,
  toolCalls: ToolCallRecord[],
  signal?: AbortSignal,
): Promise<ConverseTurn | SendWithToolsResult<T>> {
  try {
    return await withTimeout(promise, timeoutMs, signal);
  } catch (error) {
    return fallback<T>(
      error instanceof TimeoutError ||
        (error instanceof BackboardApiError &&
          (error.code === "TIMEOUT" || error.code === "ABORTED"))
        ? "TIMEOUT"
        : "PROVIDER_ERROR",
      toolCalls,
    );
  }
}

function isFallback<T>(value: unknown): value is SendWithToolsResult<T> {
  return typeof value === "object" && value !== null && "outcome" in value;
}

export async function runBoundedToolLoop<T>(
  params: RunBoundedToolLoopParams<T>,
): Promise<SendWithToolsResult<T>> {
  const maxRounds = params.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const roundTimeoutMs = params.roundTimeoutMs ?? DEFAULT_ROUND_TIMEOUT_MS;
  const toolCalls: ToolCallRecord[] = [];
  const toolsByName = new Map(params.tools.map((tool) => [tool.name, tool]));
  if (params.signal?.aborted) return fallback("TIMEOUT", toolCalls);
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 0)
    return fallback("MAX_ROUNDS_EXCEEDED", toolCalls);

  let turn = await callClient<T>(
    params.client.start({ message: params.message }),
    roundTimeoutMs,
    toolCalls,
    params.signal,
  );
  if (isFallback<T>(turn)) {
    return turn;
  }

  for (let round = 0; round <= maxRounds; round++) {
    if (params.signal?.aborted) return fallback("TIMEOUT", toolCalls);
    if (turn.status === "completed") {
      return finalize(
        (turn as ConverseTurnCompleted).text,
        toolCalls,
        params.responseSchema,
      );
    }
    if (turn.status !== "requires_action") {
      return fallback("MALFORMED_OUTPUT", toolCalls);
    }
    if (round === maxRounds) return fallback("MAX_ROUNDS_EXCEEDED", toolCalls);

    const outputs: { toolCallId: string; output: string }[] = [];
    for (const call of (turn as ConverseTurnRequiresAction).toolCalls) {
      if (params.signal?.aborted) return fallback("TIMEOUT", toolCalls);
      const startedAt = new Date().toISOString();
      const tool = toolsByName.get(call.name);
      if (!tool) {
        toolCalls.push({
          toolName: call.name,
          args: call.args,
          error: "unknown tool",
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        return fallback("MALFORMED_OUTPUT", toolCalls);
      }

      const parsedArgs = tool.parameters.safeParse(call.args);
      if (!parsedArgs.success) {
        toolCalls.push({
          toolName: call.name,
          args: call.args,
          error: "invalid tool arguments",
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        return fallback("MALFORMED_OUTPUT", toolCalls);
      }

      let actionKey: string | undefined;
      if (tool.risk === "mutating") {
        if (!params.context.orderId || !params.context.traceId) {
          toolCalls.push({
            toolName: call.name,
            args: call.args,
            error:
              "mutating tool requires traceId and orderId from server context",
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          return fallback("TOOL_GUARD_REJECTED", toolCalls);
        }
        actionKey = tool.actionKeyFor?.(parsedArgs.data, params.context);
        if (!actionKey) {
          toolCalls.push({
            toolName: call.name,
            args: call.args,
            error: "mutating tool did not derive a deterministic actionKey",
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          return fallback("TOOL_GUARD_REJECTED", toolCalls);
        }
      }

      try {
        const result = await withTimeout(
          tool.handler(parsedArgs.data, { ...params.context, actionKey }),
          roundTimeoutMs,
          params.signal,
        );
        toolCalls.push({
          toolName: call.name,
          args: call.args,
          result,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        outputs.push({ toolCallId: call.id, output: JSON.stringify(result) });
      } catch (error) {
        toolCalls.push({
          toolName: call.name,
          args: call.args,
          error:
            error instanceof TimeoutError
              ? "tool call timed out"
              : "tool execution failed",
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        return fallback(
          error instanceof TimeoutError ? "TIMEOUT" : "PROVIDER_ERROR",
          toolCalls,
        );
      }
    }

    turn = await callClient<T>(
      params.client.submitToolOutputs({ toolOutputs: outputs }),
      roundTimeoutMs,
      toolCalls,
      params.signal,
    );
    if (isFallback<T>(turn)) {
      return turn;
    }
  }

  return fallback("MAX_ROUNDS_EXCEEDED", toolCalls);
}
