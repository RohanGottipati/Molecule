import {
  CouncilRecommendationSchema,
  RecommendationSetSchema,
  type CouncilPerspectiveId,
  type CouncilRecommendation,
  type RecommendationSet,
} from "@molecule/contracts";
import type { z } from "zod";

import type { BackboardAdapter } from "./BackboardAdapter.js";
import type { SendWithToolsFallbackReason, ToolDefinition } from "./types.js";

/**
 * B7 item 79: exactly one high-risk council, always these three fixed
 * perspectives — never a variable or model-chosen roster.
 */
interface PerspectiveFraming {
  id: CouncilPerspectiveId;
  instructions: string;
}

const PERSPECTIVES: PerspectiveFraming[] = [
  {
    id: "operations",
    instructions:
      "Operations perspective: judge only whether this shop can physically " +
      "deliver by the deadline given live capacity and equipment state — not " +
      "price, legal exposure, or contract language.",
  },
  {
    id: "risk",
    instructions:
      "Risk perspective: judge only the probability and blast radius of " +
      "missing this deadline guarantee, and what mitigation would reduce it " +
      "— not whether the shop is contractually obligated to attempt it.",
  },
  {
    id: "contract",
    instructions:
      "Contract perspective: judge only the merchant's exposure if this " +
      "deadline guarantee is promised and then missed (penalties, SLA " +
      "language, precedent) — not operational feasibility.",
  },
];

const CouncilRecommendationBodySchema = CouncilRecommendationSchema.omit({
  perspective: true,
});
type CouncilRecommendationBody = z.infer<
  typeof CouncilRecommendationBodySchema
>;

export interface CouncilInput {
  merchantId: string;
  assistantId: string;
  traceId: string;
  orderId: string;
  /** Shared scenario context injected verbatim into every perspective's message. */
  scenarioContext: string;
  model?: string;
}

export interface MerchantCouncil {
  /**
   * B7 items 79-81: runs all three fixed perspectives independently — each
   * on its own fresh thread, so no perspective sees another's reasoning —
   * exactly once, with no retries, and returns a compact typed
   * RecommendationSet. This is advisory: "Orchestrator/solver validates any
   * action" (item 80), so runCouncil never reserves capacity or accepts a
   * job itself.
   */
  runCouncil(input: CouncilInput): Promise<RecommendationSet>;
}

function buildPerspectiveMessage(
  perspective: PerspectiveFraming,
  input: CouncilInput,
): string {
  return [
    `High-risk deadline-guarantee review for order ${input.orderId}.`,
    input.scenarioContext,
    "",
    perspective.instructions,
    "",
    "Use the available read tools to ground your judgement in live facts; " +
      "never invent capacity or claims.",
    "Respond with exactly one JSON object: " +
      '{"position": "APPROVE" | "APPROVE_WITH_CONDITIONS" | "REJECT", ' +
      '"rationale": string (<=600 chars), "conditions": string[], ' +
      '"confidence": number between 0 and 1}. JSON only, no surrounding text.',
  ].join("\n");
}

/**
 * B7 item 81: "one round plus deterministic validation is enough" — unlike
 * quote.ts's one-shot repair retry, a perspective that doesn't produce a
 * valid recommendation is never re-prompted at all; it fails closed
 * (REJECT, zero confidence) on the first miss. (The perspective's own
 * bounded tool-call loop underneath is unaffected — it may still call a
 * read tool before answering.)
 */
function fallbackRecommendation(
  perspective: CouncilPerspectiveId,
  reason: SendWithToolsFallbackReason,
): CouncilRecommendation {
  return {
    perspective,
    position: "REJECT",
    rationale: `${perspective} perspective produced no usable output (${reason}); defaulting to REJECT rather than guessing.`,
    conditions: [],
    confidence: 0,
  };
}

export function createMerchantCouncil(
  adapter: Pick<BackboardAdapter, "sendWithTools" | "createOrReuseOrderThread">,
  tools: ToolDefinition[],
): MerchantCouncil {
  async function runOnePerspective(
    perspective: PerspectiveFraming,
    input: CouncilInput,
  ): Promise<CouncilRecommendation> {
    // Each perspective gets its own fresh, unpersisted thread — never the
    // order's own quote thread — so perspectives are genuinely independent
    // rather than continuing one shared conversation.
    const thread = await adapter.createOrReuseOrderThread({
      merchantId: input.merchantId,
      assistantId: input.assistantId,
      orderId: `${input.orderId}:council:${perspective.id}`,
    });

    const result = await adapter.sendWithTools<CouncilRecommendationBody>({
      merchantId: input.merchantId,
      assistantId: input.assistantId,
      threadId: thread.threadId,
      traceId: input.traceId,
      orderId: input.orderId,
      message: buildPerspectiveMessage(perspective, input),
      tools,
      responseSchema: CouncilRecommendationBodySchema,
      model: input.model,
    });

    if (result.outcome === "FALLBACK") {
      return fallbackRecommendation(perspective.id, result.reason);
    }
    // COMPLETED with a responseSchema always carries data.
    return { perspective: perspective.id, ...result.data! };
  }

  async function runCouncil(input: CouncilInput): Promise<RecommendationSet> {
    const recommendations = await Promise.all(
      PERSPECTIVES.map((perspective) => runOnePerspective(perspective, input)),
    );

    return RecommendationSetSchema.parse({
      orderId: input.orderId,
      merchantId: input.merchantId,
      traceId: input.traceId,
      scenario: "deadline_guarantee",
      recommendations,
      generatedAt: new Date().toISOString(),
    });
  }

  return { runCouncil };
}
