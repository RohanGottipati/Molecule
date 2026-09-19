import type { z } from "zod";

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError("round timed out")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
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
    candidate = JSON.parse(text);
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
): Promise<ConverseTurn | SendWithToolsResult<T>> {
  try {
    return await withTimeout(promise, timeoutMs);
  } catch (error) {
    return fallback<T>(
      error instanceof TimeoutError ? "TIMEOUT" : "PROVIDER_ERROR",
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

  let turn = await callClient<T>(
    params.client.start({ message: params.message }),
    roundTimeoutMs,
    toolCalls,
  );
  if (isFallback<T>(turn)) {
    return turn;
  }

  for (let round = 0; round < maxRounds; round++) {
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

    const outputs: { toolCallId: string; output: string }[] = [];
    for (const call of (turn as ConverseTurnRequiresAction).toolCalls) {
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
              : String(error),
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
    );
    if (isFallback<T>(turn)) {
      return turn;
    }
  }

  return fallback("MAX_ROUNDS_EXCEEDED", toolCalls);
}
