import { z } from "zod";

export const CurrencySchema = z.enum(["CAD", "USD"]);
export type Currency = z.infer<typeof CurrencySchema>;

export const DesiredOutputSchema = z.object({
  outputId: z.string(),
  name: z.string().min(1),
  quantity: z.number().int().positive().optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

export const TransformationNeedSchema = z.object({
  transformationId: z.string(),
  kind: z.string().min(1),
  description: z.string().min(1),
  inputRefs: z.array(z.string()).default([]),
  outputRefs: z.array(z.string()).default([]),
});

export const ConstraintOperatorSchema = z.enum([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "contains",
]);

export const ConstraintSchema = z.object({
  constraintId: z.string(),
  field: z.string().min(1),
  operator: ConstraintOperatorSchema,
  value: z.unknown(),
  unit: z.string().optional(),
  description: z.string().optional(),
});

export const WeightedPreferenceSchema = ConstraintSchema.extend({
  weight: z.number().min(0).max(1),
});

export const AssetRefSchema = z
  .object({
    assetId: z.string(),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    url: z.url().optional(),
    checksum: z.string().optional(),
  })
  .refine((asset) => asset.url !== undefined || asset.checksum !== undefined, {
    message: "An asset must have a URL or checksum",
  });

export const AmbiguityFlagSchema = z.object({
  field: z.string(),
  reason: z.string(),
  question: z.string().optional(),
});

export const ProductIntentSchema = z.object({
  intentId: z.uuid(),
  version: z.number().int().positive(),
  quantity: z.number().int().positive(),
  deadline: z.iso.datetime(),
  currency: CurrencySchema,
  budgetMax: z.number().positive().optional(),
  desiredOutputs: z.array(DesiredOutputSchema).min(1),
  transformations: z.array(TransformationNeedSchema),
  hardConstraints: z.array(ConstraintSchema),
  softPreferences: z.array(WeightedPreferenceSchema),
  assets: z.array(AssetRefSchema).default([]),
  ambiguityFlags: z.array(AmbiguityFlagSchema).default([]),
});
export type ProductIntent = z.infer<typeof ProductIntentSchema>;

export const CapabilityPortSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

export const QuantityRangeSchema = z
  .object({
    min: z.number().nonnegative(),
    max: z.number().positive(),
    unit: z.string().min(1),
  })
  .refine((range) => range.max >= range.min, {
    message: "Quantity max must be greater than or equal to min",
  });

export const PricingRuleSchema = z.object({
  currency: CurrencySchema,
  unitPrice: z.number().nonnegative().optional(),
  setupFee: z.number().nonnegative().default(0),
  minimumTotal: z.number().nonnegative().optional(),
});

export const DurationRangeSchema = z
  .object({
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
    unit: z.enum(["minutes", "hours", "business_hours", "days"]),
  })
  .refine((range) => range.max >= range.min, {
    message: "Duration max must be greater than or equal to min",
  });

export const CapacityRuleSchema = z.object({
  available: z.number().nonnegative().optional(),
  maximum: z.number().positive().optional(),
  period: z.enum(["hour", "day", "week"]).optional(),
  asOf: z.iso.datetime().optional(),
});

export const MerchantCapabilitySchema = z.object({
  capabilityId: z.string(),
  merchantId: z.string(),
  kind: z.enum(["SUPPLY", "TRANSFORM", "ASSEMBLE", "FULFILL"]),
  name: z.string(),
  description: z.string(),
  accepts: z.array(CapabilityPortSchema),
  produces: z.array(CapabilityPortSchema),
  quantity: QuantityRangeSchema,
  pricing: PricingRuleSchema,
  leadTime: DurationRangeSchema,
  capacity: CapacityRuleSchema,
  hardRules: z.array(ConstraintSchema),
  softRules: z.array(ConstraintSchema),
  sourceClaimIds: z.array(z.string()),
});
export type MerchantCapability = z.infer<typeof MerchantCapabilitySchema>;

export const ClaimSourceSchema = z.object({
  kind: z.enum(["shopify", "csv", "document", "note", "api", "manual"]),
  reference: z.string(),
  checksum: z.string().optional(),
});

export const CanonicalClaimSchema = z.object({
  claimId: z.string(),
  merchantId: z.string(),
  field: z.string(),
  normalizedValue: z.unknown(),
  normalizedUnit: z.string().optional(),
  source: ClaimSourceSchema,
  observedAt: z.iso.datetime().optional(),
  ingestedAt: z.iso.datetime(),
  sourceAuthority: z.number().min(0).max(1),
  extractionConfidence: z.number().min(0).max(1),
  resolutionStatus: z.enum([
    "active",
    "superseded",
    "conflicted",
    "quarantined",
    "unknown",
  ]),
  evidenceText: z.string().optional(),
});
export type CanonicalClaim = z.infer<typeof CanonicalClaimSchema>;

export const ConstraintPatchSchema = z.object({
  constraintId: z.string().optional(),
  operation: z.enum(["add", "replace", "remove"]),
  path: z.string(),
  value: z.unknown().optional(),
});

/**
 * B4 typed quote protocol input. Carries only order context, the capability
 * requirement, and which canonical fields are relevant — the merchant agent
 * injects live values for those fields itself rather than trusting anything
 * passed here as fact. `hold` is the sole signal that a CAN_ACCEPT quote
 * should actually reserve capacity; a false/absent hold keeps the quote
 * non-binding regardless of what the merchant assistant proposes.
 */
export const QuoteRequestSchema = z.object({
  orderId: z.string().min(1),
  traceId: z.string().min(1),
  merchantId: z.string().min(1),
  capabilityId: z.string().min(1),
  quantity: z.number().int().positive(),
  currency: CurrencySchema,
  deadline: z.iso.datetime().optional(),
  hold: z.boolean().default(false),
  relevantClaimFields: z.array(z.string()).default([]),
  constraints: z.array(ConstraintSchema).default([]),
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const QuoteResponseSchema = z.object({
  merchantId: z.string(),
  capabilityId: z.string(),
  status: z.enum(["CAN_ACCEPT", "COUNTEROFFER", "DECLINE"]),
  unitPrice: z.number().nonnegative().optional(),
  setupFee: z.number().nonnegative().default(0),
  currency: CurrencySchema,
  maxQuantity: z.number().int().positive().optional(),
  completionEstimate: z.iso.datetime().optional(),
  reservationId: z.string().optional(),
  requiredChanges: z.array(ConstraintPatchSchema).default([]),
  confidence: z.number().min(0).max(1),
  explanation: z.string().max(600),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

/**
 * B5 sanitized merchant-memory card contract: the fact and its timestamp/
 * source thread, never hidden model reasoning. This is the shape the
 * merchant-agents memory endpoint returns and a UI merchant-memory card
 * renders directly.
 */
export const MerchantMemoryCardEntrySchema = z.object({
  merchantId: z.string().min(1),
  memoryId: z.string().min(1),
  note: z.string().min(1),
  sourceThreadId: z.string().optional(),
  recordedAt: z.iso.datetime(),
});
export type MerchantMemoryCardEntry = z.infer<
  typeof MerchantMemoryCardEntrySchema
>;

/**
 * B7 optional merchant council: three fixed perspectives (never a variable
 * roster) evaluating one high-risk deadline-guarantee scenario.
 */
export const CouncilPerspectiveIdSchema = z.enum([
  "operations",
  "risk",
  "contract",
]);
export type CouncilPerspectiveId = z.infer<typeof CouncilPerspectiveIdSchema>;

/**
 * B7 item 80: a compact typed recommendation, not free-form prose. This is
 * advisory only — "Orchestrator/solver validates any action" (item 80), so a
 * council recommendation never itself reserves capacity or accepts a job.
 */
export const CouncilRecommendationSchema = z.object({
  perspective: CouncilPerspectiveIdSchema,
  position: z.enum(["APPROVE", "APPROVE_WITH_CONDITIONS", "REJECT"]),
  rationale: z.string().max(600),
  conditions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type CouncilRecommendation = z.infer<typeof CouncilRecommendationSchema>;

/**
 * B7 item 81: exactly one round — no back-and-forth between perspectives —
 * so a RecommendationSet always carries exactly the three fixed
 * perspectives' recommendations, each independently arrived at.
 */
export const RecommendationSetSchema = z.object({
  orderId: z.string().min(1),
  merchantId: z.string().min(1),
  traceId: z.string().min(1),
  scenario: z.literal("deadline_guarantee"),
  recommendations: z.array(CouncilRecommendationSchema).length(3),
  generatedAt: z.iso.datetime(),
});
export type RecommendationSet = z.infer<typeof RecommendationSetSchema>;

export const PlanNodeSchema = z.object({
  nodeId: z.string(),
  merchantId: z.string(),
  capabilityId: z.string(),
  kind: z.enum(["SUPPLY", "TRANSFORM", "ASSEMBLE", "FULFILL"]),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
  totalCost: z.number().nonnegative(),
  startsAt: z.iso.datetime().optional(),
  completesAt: z.iso.datetime().optional(),
});

export const PlanEdgeSchema = z.object({
  edgeId: z.string(),
  fromNodeId: z.string(),
  toNodeId: z.string(),
  material: z.string(),
  quantity: z.number().positive(),
  unit: z.string(),
});

export const ConstraintResultSchema = z.object({
  constraintId: z.string(),
  satisfied: z.boolean(),
  actualValue: z.unknown().optional(),
  explanation: z.string(),
});

export const ConstraintRelaxationSchema = z.object({
  constraintId: z.string(),
  proposedValue: z.unknown(),
  explanation: z.string(),
});

export const ProductionPlanSchema = z
  .object({
    planId: z.string(),
    orderId: z.string(),
    intentVersion: z.number().int().positive(),
    status: z.enum(["VALID", "UNSAT"]),
    nodes: z.array(PlanNodeSchema),
    edges: z.array(PlanEdgeSchema),
    totalCost: z.number().nonnegative(),
    currency: CurrencySchema,
    estimatedCompletion: z.iso.datetime().optional(),
    riskScore: z.number().min(0).max(1),
    constraintResults: z.array(ConstraintResultSchema),
    unsatRelaxations: z.array(ConstraintRelaxationSchema).default([]),
  })
  .superRefine((plan, context) => {
    if (
      plan.status === "VALID" &&
      plan.constraintResults.some((result) => !result.satisfied)
    ) {
      context.addIssue({
        code: "custom",
        message: "A VALID plan cannot contain an unsatisfied constraint",
        path: ["constraintResults"],
      });
    }
  });
export type ProductionPlan = z.infer<typeof ProductionPlanSchema>;

export const MoleculeEventSchema = z.object({
  eventId: z.uuid(),
  traceId: z.string().min(1),
  orderId: z.string().optional(),
  planId: z.string().optional(),
  merchantId: z.string().optional(),
  eventType: z.string().min(1),
  ts: z.iso.datetime(),
  severity: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]),
  source: z.enum([
    "openai",
    "rox",
    "backboard",
    "tiger",
    "shopify",
    "solver",
    "ui",
  ]),
  payload: z.record(z.string(), z.unknown()),
});
export type MoleculeEvent = z.infer<typeof MoleculeEventSchema>;
