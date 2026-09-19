import {
  createMerchantCouncil,
  type BackboardAdapter,
  type MerchantAgentRepository,
  type MerchantMemoryEntry,
  type MerchantTwinService,
  type ModelRouter,
  type SendWithToolsFallbackReason,
  type TaskDescriptor,
} from "@molecule/backboard";
import {
  ConstraintSchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
  type CanonicalClaim,
  type QuoteRequest,
  type QuoteResponse,
  type RecommendationSet,
} from "@molecule/contracts";
import type { z } from "zod";

import { InsufficientCapacityError } from "./capacityStore.js";
import {
  createMerchantAgentTools,
  type MerchantAgentToolsDeps,
} from "./tools.js";

export interface QuoteServiceDeps {
  adapter: BackboardAdapter;
  twin: MerchantTwinService;
  repository: MerchantAgentRepository;
  tools: MerchantAgentToolsDeps;
  modelRouter: ModelRouter;
  /**
   * B7 item 79-81 optional merchant council. Undefined/disabled is the
   * default and leaves QuoteRequestSchema/QuoteResponseSchema and this
   * service's return value completely unchanged — the flag only controls
   * whether an out-of-band RecommendationSet gets produced for a deadline-
   * guarantee request, never what handleQuoteRequest returns.
   */
  council?: {
    enabled: boolean;
    onRecommendation?: (recommendationSet: RecommendationSet) => void;
  };
}

/**
 * B6 item 77: a firm hold against a deadline is the "high-value deadline
 * guarantee" case and routes to HIGH_REASONING; every other quote request is
 * the low-stakes case and routes to FAST_OPS. This never depends on how many
 * distinct lanes/models get used — only on the request's own shape.
 */
function describeQuoteTask(request: QuoteRequest): TaskDescriptor {
  if (request.hold && request.deadline) {
    return { kind: "deadline_guarantee" };
  }
  return { kind: "low_stakes_inventory" };
}

/**
 * The merchant assistant returned something that could not be turned into a
 * valid QuoteResponse even after one repair attempt (B4 item 68: "repair
 * once ... then fail visibly rather than accepting malformed JSON", mirrored
 * from O2's compiler rule). The caller must not synthesize a quote.
 */
export class QuoteProtocolError extends Error {
  constructor(
    message: string,
    public readonly merchantId: string,
  ) {
    super(message);
    this.name = "QuoteProtocolError";
  }
}

/**
 * The merchant assistant did not produce any quote (timeout, provider error,
 * round limit, or a mutating tool call rejected for missing context). This is
 * distinct from QuoteProtocolError: per O4, a caller fanning out to several
 * merchants should treat this as "unavailable", not a fatal order failure.
 */
export class MerchantQuoteUnavailableError extends Error {
  constructor(
    public readonly merchantId: string,
    public readonly reason: SendWithToolsFallbackReason,
  ) {
    super(`Merchant ${merchantId} did not produce a quote (${reason})`);
    this.name = "MerchantQuoteUnavailableError";
  }
}

export interface QuoteService {
  handleQuoteRequest(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<QuoteResponse>;
}

function formatClaim(claim: CanonicalClaim): string {
  const unit = claim.normalizedUnit ? ` ${claim.normalizedUnit}` : "";
  return `- ${claim.field}: ${JSON.stringify(claim.normalizedValue)}${unit} (status: ${claim.resolutionStatus}, source: ${claim.source.kind})`;
}

function formatConstraint(
  constraint: z.infer<typeof ConstraintSchema>,
): string {
  return `- ${constraint.field} ${constraint.operator} ${JSON.stringify(constraint.value)}`;
}

/**
 * B5 item 72: the message only ever carries the sanitized fact and when it
 * was recorded — never hidden reasoning, and never the memory entry's
 * internal assistantId/memoryId.
 */
function formatMemory(entry: MerchantMemoryEntry): string {
  return `- ${entry.note} (recorded ${entry.recordedAt})`;
}

/**
 * Injects only order context, the capability requirement, the caller-
 * selected relevant canonical facts (item 67), and recalled merchant memory
 * — never a dump of everything known about the merchant.
 */
function buildQuoteMessage(
  request: QuoteRequest,
  claims: CanonicalClaim[],
  memory: MerchantMemoryEntry[],
): string {
  return [
    `New quote request for order ${request.orderId}.`,
    `Capability required: ${request.capabilityId}`,
    `Quantity: ${request.quantity}`,
    request.deadline ? `Deadline: ${request.deadline}` : undefined,
    `Currency: ${request.currency}`,
    request.hold
      ? "This is a firm hold request: only report CAN_ACCEPT if capacity can be committed now."
      : "This is a non-binding quote request; do not reserve capacity.",
    "",
    "Relevant canonical facts (live truth for this quote; do not use any other source for these fields):",
    claims.length > 0 ? claims.map(formatClaim).join("\n") : "- none supplied",
    "",
    "Relevant order constraints:",
    request.constraints.length > 0
      ? request.constraints.map(formatConstraint).join("\n")
      : "- none",
    "",
    memory.length > 0
      ? [
          "Remembered merchant policy (recorded by this merchant on a prior order " +
            "thread; durable across threads, but bounded by live tool results — " +
            "never treat a remembered fact as current capacity/inventory):",
          memory.map(formatMemory).join("\n"),
        ].join("\n")
      : undefined,
    memory.length > 0 ? "" : undefined,
    "Use the calculate_quote tool for live pricing and capacity before answering. " +
      "Respond with exactly one JSON object matching QuoteResponseSchema: status is " +
      "CAN_ACCEPT, COUNTEROFFER, or DECLINE. A COUNTEROFFER must include requiredChanges " +
      "as structured constraint patches (price, quantity, completion estimate, material/" +
      "color change) — never vague prose. Reply with JSON only, no surrounding text.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * B7: the shared, sanitized context every council perspective sees — order
 * context and the same relevant canonical facts injected into the quote
 * message itself, never the merchant's raw quote conversation.
 */
function buildCouncilScenarioContext(
  request: QuoteRequest,
  claims: CanonicalClaim[],
): string {
  return [
    `Order ${request.orderId} requests a firm deadline guarantee.`,
    `Capability: ${request.capabilityId}`,
    `Quantity: ${request.quantity}`,
    request.deadline ? `Deadline: ${request.deadline}` : undefined,
    `Currency: ${request.currency}`,
    "",
    "Relevant canonical facts (live truth; do not use any other source for these fields):",
    claims.length > 0 ? claims.map(formatClaim).join("\n") : "- none supplied",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

const REPAIR_MESSAGE = [
  "Your previous reply could not be validated. Reply again with exactly one strict JSON",
  "object matching QuoteResponseSchema (status: CAN_ACCEPT | COUNTEROFFER | DECLINE; a",
  "COUNTEROFFER must include at least one structured entry in requiredChanges). No prose,",
  "no markdown, JSON only.",
].join(" ");

/**
 * Item 70: a COUNTEROFFER carrying no structured requiredChanges is vague
 * prose wearing the right status code. QuoteResponseSchema can't express
 * "non-empty when COUNTEROFFER" on its own, so this is checked alongside it.
 */
function isStructurallyComplete(candidate: QuoteResponse): boolean {
  if (
    candidate.status === "COUNTEROFFER" &&
    candidate.requiredChanges.length === 0
  ) {
    return false;
  }
  return true;
}

export function createQuoteService(deps: QuoteServiceDeps): QuoteService {
  const tools = createMerchantAgentTools(deps.tools);
  // B7 item 80: perspectives only ever read live facts, never mutate.
  const readOnlyTools = tools.filter((tool) => tool.risk === "read");
  const council = createMerchantCouncil(deps.adapter, readOnlyTools);

  async function requestQuote(
    request: QuoteRequest,
    assistantId: string,
    threadId: string,
    message: string,
    model: string,
    signal?: AbortSignal,
  ) {
    return deps.adapter.sendWithTools<QuoteResponse>({
      merchantId: request.merchantId,
      assistantId,
      threadId,
      traceId: request.traceId,
      orderId: request.orderId,
      message,
      tools: readOnlyTools,
      signal,
      responseSchema: QuoteResponseSchema,
      model,
    });
  }

  async function reconcileHold(
    request: QuoteRequest,
    quote: QuoteResponse,
  ): Promise<QuoteResponse> {
    // Server-authoritative identity: never trust the model's echoed
    // merchantId/capabilityId for routing/reservation decisions.
    const grounded: QuoteResponse = {
      ...quote,
      merchantId: request.merchantId,
      capabilityId: request.capabilityId,
    };

    if (grounded.status !== "CAN_ACCEPT" || !request.hold) {
      // Item 69: only a held CAN_ACCEPT may carry a reservation; anything
      // else stays explicitly non-binding even if the model proposed one.
      return { ...grounded, reservationId: undefined };
    }

    const actionKey =
      request.actionKey ??
      `quote-hold:${request.merchantId}:${request.orderId}:${request.intentVersion}:${request.capabilityId}:${request.quantity}`;
    try {
      const reservation = await deps.tools.capacity.reserve({
        traceId: request.traceId,
        merchantId: request.merchantId,
        capabilityId: request.capabilityId,
        orderId: request.orderId,
        quantity: request.quantity,
        actionKey,
      });
      return { ...grounded, reservationId: reservation.reservationId };
    } catch (error) {
      if (error instanceof InsufficientCapacityError) {
        return {
          ...grounded,
          status: "DECLINE",
          reservationId: undefined,
          explanation:
            "Capacity was committed to a concurrent hold before this reservation could complete.",
        };
      }
      throw error;
    }
  }

  async function handleQuoteRequest(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<QuoteResponse> {
    const request = QuoteRequestSchema.parse(input);
    if (signal?.aborted)
      throw new MerchantQuoteUnavailableError(request.merchantId, "TIMEOUT");

    const assistant = await deps.repository.getAssistant(request.merchantId);
    if (!assistant) {
      throw new Error(
        `No Backboard assistant provisioned for merchant ${request.merchantId}`,
      );
    }
    const thread = await deps.twin.ensureOrderThread({
      merchantId: request.merchantId,
      orderId: request.orderId,
    });
    const claims = await deps.tools.canonicalData.getCanonicalClaims(
      request.merchantId,
      request.relevantClaimFields,
    );
    // B5: recalled fresh on every quote request rather than cached, so a
    // memory written after this thread was created is still picked up.
    const memory = await deps.adapter.recallMerchantMemory({
      merchantId: request.merchantId,
      assistantId: assistant.assistantId,
    });
    // B6: routing never touches assistant/thread identity above — only which
    // model this run uses.
    const task = describeQuoteTask(request);
    const { selection: modelSelection } = await deps.modelRouter.selectModel({
      task,
      traceId: request.traceId,
      merchantId: request.merchantId,
      orderId: request.orderId,
    });

    const messages = [
      buildQuoteMessage(request, claims, memory),
      REPAIR_MESSAGE,
    ];
    let candidate: QuoteResponse | undefined;

    for (const message of messages) {
      const result = await requestQuote(
        request,
        assistant.assistantId,
        thread.threadId,
        message,
        modelSelection.modelId,
        signal,
      );

      if (result.outcome === "FALLBACK") {
        if (result.reason !== "MALFORMED_OUTPUT") {
          throw new MerchantQuoteUnavailableError(
            request.merchantId,
            result.reason,
          );
        }
        continue; // one repair attempt, driven by the next message in the loop
      }

      // COMPLETED with a responseSchema always carries data (finalize() only
      // returns COMPLETED once QuoteResponseSchema.safeParse has succeeded).
      if (result.data && isStructurallyComplete(result.data)) {
        candidate = result.data;
        break;
      }
    }

    if (!candidate) {
      throw new QuoteProtocolError(
        `Merchant ${request.merchantId} did not return a structurally valid quote after one repair attempt.`,
        request.merchantId,
      );
    }

    if (signal?.aborted)
      throw new MerchantQuoteUnavailableError(request.merchantId, "TIMEOUT");
    const final = await reconcileHold(request, candidate);
    const validated = QuoteResponseSchema.parse(final);

    // B7 item 78 acceptance: disabling this flag never changes the quote
    // API — the council runs out-of-band and its RecommendationSet never
    // reaches the returned QuoteResponse.
    if (deps.council?.enabled && task.kind === "deadline_guarantee") {
      try {
        const recommendationSet = await council.runCouncil({
          merchantId: request.merchantId,
          assistantId: assistant.assistantId,
          traceId: request.traceId,
          orderId: request.orderId,
          scenarioContext: buildCouncilScenarioContext(request, claims),
          model: modelSelection.modelId,
        });
        deps.council.onRecommendation?.(recommendationSet);
      } catch {
        // Advisory only: a council failure must never break the quote
        // response the caller is waiting on.
      }
    }

    return validated;
  }

  return { handleQuoteRequest };
}
