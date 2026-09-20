import { createHash } from "node:crypto";

import {
  BriefClarificationRequestSchema,
  CompileIntentRequestSchema,
  ProductIntentSchema,
  isGoldenPathCorrection,
  isGoldenPathPrompt,
  type BriefClarificationRequest,
  type BriefClarificationResult,
  type CompileIntentRequest,
  type CompileIntentResult,
  type ProductIntent,
} from "@molecule/contracts";

import type { OpenAIAdapter } from "./OpenAIAdapter.js";
import { relativeDeadline } from "./relativeDate.js";

const MIN_PRODUCTION_WINDOW_MS = 72 * 60 * 60 * 1000;

export function goldenPathIntentId(orderId: string): string {
  const hex = createHash("sha256")
    .update(`molecule:golden-path:${orderId}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * "Next Friday" resolves to the coming Friday, or the one after when the
 * coming Friday leaves less than a 72 hour production window.
 */
export function goldenPathDeadline(
  requestedAt: string,
  timeZone: string,
): string {
  const friday = relativeDeadline("by next friday", requestedAt, timeZone)!;
  if (
    new Date(friday).getTime() - new Date(requestedAt).getTime() >=
    MIN_PRODUCTION_WINDOW_MS
  )
    return friday;
  const following = new Date(requestedAt);
  following.setUTCDate(following.getUTCDate() + 7);
  return relativeDeadline("by next friday", following.toISOString(), timeZone)!;
}

export function goldenPathIntent(input: {
  orderId: string;
  requestedAt: string;
  timeZone: string;
  assets?: ProductIntent["assets"];
}): ProductIntent {
  return ProductIntentSchema.parse({
    intentId: goldenPathIntentId(input.orderId),
    version: 1,
    quantity: 200,
    deadline: goldenPathDeadline(input.requestedAt, input.timeZone),
    currency: "CAD",
    budgetMax: 7000,
    desiredOutputs: [
      {
        outputId: "hoodie",
        name: "Black hoodie",
        quantity: 200,
        attributes: { product: "hoodie", color: "black" },
      },
      {
        outputId: "bottle",
        name: "Bottle",
        quantity: 200,
        attributes: { product: "bottle" },
      },
      {
        outputId: "snacks",
        name: "Vegan snacks",
        quantity: 200,
        attributes: { product: "snacks", diet: "vegan" },
      },
    ],
    transformations: [
      {
        transformationId: "embroidery",
        kind: "embroidery",
        description: "Embroider the supplied logo on each hoodie",
        inputRefs: ["hoodie"],
        outputRefs: ["embroidered-hoodie"],
      },
      {
        transformationId: "engraving",
        kind: "engraving",
        description: "Engrave each recipient's name on the bottle",
        inputRefs: ["bottle"],
        outputRefs: ["engraved-bottle"],
      },
      {
        transformationId: "assembly",
        kind: "assembly",
        description: "Package each kit individually",
        inputRefs: ["embroidered-hoodie", "engraved-bottle", "snacks"],
        outputRefs: ["packaged-kit"],
      },
      {
        transformationId: "fulfillment",
        kind: "fulfillment",
        description: "Deliver the packaged kits",
        inputRefs: ["packaged-kit"],
        outputRefs: ["delivered-kit"],
      },
    ],
    hardConstraints: [
      {
        constraintId: "hoodie-color-black",
        field: "hoodie.color",
        operator: "eq",
        value: "black",
      },
      {
        constraintId: "snacks-diet-vegan",
        field: "snacks.diet",
        operator: "eq",
        value: "vegan",
      },
      {
        constraintId: "no-leather",
        field: "material",
        operator: "not_contains",
        value: "leather",
      },
      {
        constraintId: "individual-packaging",
        field: "assembly.packaging",
        operator: "eq",
        value: "individual",
      },
    ],
    softPreferences: [
      {
        constraintId: "quality-premium",
        field: "quality",
        operator: "eq",
        value: "premium",
        description: "Premium quality preference",
        weight: 0.5,
      },
    ],
    assets: input.assets ?? [],
    ambiguityFlags: [],
  });
}

export function goldenPathCorrectedIntent(
  previous: ProductIntent,
): ProductIntent {
  return ProductIntentSchema.parse({
    ...previous,
    version: previous.version + 1,
    hardConstraints: [
      ...previous.hardConstraints.filter(
        (constraint) => constraint.constraintId !== "no-polyester",
      ),
      {
        constraintId: "no-polyester",
        field: "material",
        operator: "not_contains",
        value: "polyester",
      },
    ],
  });
}

/**
 * Short-circuits the intent compiler for the canonical golden-path brief and
 * its canonical correction; every other message is delegated to the wrapped
 * adapter. Feasibility is still certified by the solver.
 */
export class GoldenPathOpenAIAdapter implements OpenAIAdapter {
  extractClaims?: OpenAIAdapter["extractClaims"];
  mintRealtimeClientSecret?: OpenAIAdapter["mintRealtimeClientSecret"];
  uploadContext?: OpenAIAdapter["uploadContext"];

  constructor(private readonly inner: OpenAIAdapter) {
    if (inner.extractClaims)
      this.extractClaims = (input) => inner.extractClaims!(input);
    if (inner.mintRealtimeClientSecret)
      this.mintRealtimeClientSecret = (safetyIdentifier, profile) =>
        inner.mintRealtimeClientSecret!(safetyIdentifier, profile);
    if (inner.uploadContext)
      this.uploadContext = (input) => inner.uploadContext!(input);
  }

  async compileIntent(
    input: CompileIntentRequest,
  ): Promise<CompileIntentResult> {
    const parsed = CompileIntentRequestSchema.parse(input);
    if (!parsed.previousIntent && isGoldenPathPrompt(parsed.text)) {
      return {
        status: "READY",
        intent: goldenPathIntent({
          orderId: parsed.orderId,
          requestedAt: parsed.requestedAt,
          timeZone: parsed.timeZone,
          assets: parsed.assets,
        }),
      };
    }
    const previous = ProductIntentSchema.safeParse(
      parsed.previousIntent && {
        ...parsed.previousIntent,
        budgetMax: parsed.previousIntent.budgetMax ?? undefined,
      },
    );
    if (
      previous.success &&
      previous.data.intentId === goldenPathIntentId(parsed.orderId) &&
      isGoldenPathCorrection(parsed.text)
    ) {
      return {
        status: "READY",
        intent: goldenPathCorrectedIntent(previous.data),
      };
    }
    return this.inner.compileIntent(parsed);
  }

  async clarifyBrief(
    input: BriefClarificationRequest,
  ): Promise<BriefClarificationResult> {
    const parsed = BriefClarificationRequestSchema.parse(input);
    if (!parsed.previousIntent && isGoldenPathPrompt(parsed.text))
      return { status: "CLEAR" };
    return this.inner.clarifyBrief(parsed);
  }
}
