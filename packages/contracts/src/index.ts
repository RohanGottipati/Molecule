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
  "not_contains",
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
    providerFileId: z.string().optional(),
  })
  .refine((asset) => asset.url !== undefined || asset.checksum !== undefined, {
    message: "An asset must have a URL or checksum",
  });
export type AssetRef = z.infer<typeof AssetRefSchema>;

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

export const ProductIntentDraftSchema = ProductIntentSchema.extend({
  quantity: z.number().int().positive().nullable(),
  deadline: z.iso.datetime().nullable(),
  currency: CurrencySchema.nullable(),
  budgetMax: z.number().positive().nullable().optional(),
  desiredOutputs: z.array(DesiredOutputSchema),
});
export type ProductIntentDraft = z.infer<typeof ProductIntentDraftSchema>;

export const CompileIntentRequestSchema = z.strictObject({
  orderId: z.string().min(1),
  traceId: z.string().min(1),
  text: z.string().min(1),
  locale: z.string().min(2).default("en-CA"),
  timeZone: z.string().min(1).default("UTC"),
  requestedAt: z.iso.datetime(),
  assets: z.array(AssetRefSchema).default([]),
  previousIntent: ProductIntentDraftSchema.optional(),
  correction: z
    .object({
      kind: z.enum([
        "constraint",
        "preference",
        "quantity",
        "deadline",
        "budget",
        "other",
      ]),
      text: z.string().min(1),
    })
    .optional(),
});
export type CompileIntentRequest = z.infer<typeof CompileIntentRequestSchema>;

export const CompileIntentResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("READY"),
    intent: ProductIntentSchema,
  }),
  z.strictObject({
    status: z.literal("NEEDS_CLARIFICATION"),
    draft: ProductIntentDraftSchema,
    questions: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    status: z.literal("UNSUPPORTED"),
    reason: z.string().min(1),
  }),
]);
export type CompileIntentResult = z.infer<typeof CompileIntentResultSchema>;

export const ClaimSourceSchema = z.object({
  kind: z.enum(["shopify", "csv", "document", "note", "api", "manual"]),
  reference: z.string(),
  checksum: z.string().optional(),
});

export const ClaimExtractionRequestSchema = z
  .strictObject({
    traceId: z.string().min(1),
    merchantId: z.string().min(1),
    source: ClaimSourceSchema.optional(),
    text: z.string().min(1).optional(),
    assets: z.array(AssetRefSchema).default([]),
    locale: z.string().min(2).default("en-CA"),
  })
  .refine((input) => input.text !== undefined || input.assets.length > 0, {
    message: "Claim extraction requires text or an asset",
  });
export type ClaimExtractionRequest = z.infer<
  typeof ClaimExtractionRequestSchema
>;

export const ExtractedClaimCandidateSchema = z.strictObject({
  field: z.string().min(1),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.array(z.number()),
  ]),
  normalizedUnit: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  evidenceText: z.string().nullable(),
  ambiguity: z.string().nullable(),
});
export type ExtractedClaimCandidate = z.infer<
  typeof ExtractedClaimCandidateSchema
>;

export const ClaimExtractionResultSchema = z.strictObject({
  merchantId: z.string().min(1),
  candidates: z.array(ExtractedClaimCandidateSchema),
});
export type ClaimExtractionResult = z.infer<typeof ClaimExtractionResultSchema>;

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
export const QuoteRequestSchema = z
  .strictObject({
    orderId: z.string().min(1),
    traceId: z.string().min(1),
    merchantId: z.string().min(1),
    capabilityId: z.string().min(1),
    intentVersion: z.number().int().positive().default(1),
    quantity: z.number().int().positive(),
    currency: CurrencySchema,
    deadline: z.iso.datetime().optional(),
    hold: z.boolean().default(false),
    actionKey: z.string().min(1).optional(),
    hardConstraints: z.array(ConstraintSchema).default([]),
    softPreferences: z.array(WeightedPreferenceSchema).default([]),
    relevantClaimFields: z.array(z.string()).default([]),
    constraints: z.array(ConstraintSchema).default([]),
  })
  .transform((request) => {
    const constraints = [
      ...new Map(
        [...request.constraints, ...request.hardConstraints].map(
          (constraint) => [constraint.constraintId, constraint],
        ),
      ).values(),
    ];
    return { ...request, constraints, hardConstraints: constraints };
  });
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const CurrentQuoteRequestSchema = QuoteRequestSchema.refine(
  (request) => request.deadline !== undefined,
  {
    message: "An executable quote request requires a deadline",
    path: ["deadline"],
  },
);

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

export const CandidateRiskSchema = z.strictObject({
  p50Hours: z.number().nonnegative().optional(),
  p95Hours: z.number().nonnegative().optional(),
  p99Hours: z.number().nonnegative().optional(),
  sampleCount: z.number().int().nonnegative(),
  confidence: z.enum(["low", "medium", "high"]),
});

export const CandidateCapabilitySchema = z.strictObject({
  capabilityId: z.string().min(1),
  merchantId: z.string().min(1),
  score: z.number(),
  capability: MerchantCapabilitySchema,
  risk: CandidateRiskSchema.optional(),
  blockedReasons: z.array(z.string()).default([]),
});
export type CandidateCapability = z.infer<typeof CandidateCapabilitySchema>;

export const SolverInputSchema = z.strictObject({
  orderId: z.string().min(1),
  traceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  now: z.iso.datetime(),
  intent: ProductIntentSchema,
  candidates: z.array(CandidateCapabilitySchema),
  quotes: z.array(QuoteResponseSchema),
  changePenaltyNodeIds: z.array(z.string()).default([]),
});
export type SolverInput = z.infer<typeof SolverInputSchema>;

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

export const ExecutionActionReceiptSchema = z.strictObject({
  actionKey: z.string().min(1),
  kind: z.enum([
    "CAPACITY_RESERVATION",
    "COMPOSITE_PRODUCT",
    "SUPPLIER_JOB",
    "CUSTOMER_ORDER",
    "SUPERSEDE_SUPPLIER_JOB",
  ]),
  status: z.enum(["PENDING", "SUCCEEDED", "FAILED", "COMPENSATED"]),
  providerRef: z.string().optional(),
  errorCode: z.string().optional(),
});
export type ExecutionActionReceipt = z.infer<
  typeof ExecutionActionReceiptSchema
>;

export const ExecutionReceiptSchema = z.strictObject({
  orderId: z.string().min(1),
  planId: z.string().min(1),
  intentVersion: z.number().int().positive(),
  actions: z.array(ExecutionActionReceiptSchema),
  compositeProduct: z
    .strictObject({
      storeDomain: z.string(),
      productGid: z.string(),
      variantGid: z.string().optional(),
      adminUrl: z.url().optional(),
      storefrontUrl: z.url().optional(),
    })
    .optional(),
  customerOrder: z
    .strictObject({
      draftOrderGid: z.string().optional(),
      orderGid: z.string().optional(),
      checkoutUrl: z.url().optional(),
    })
    .optional(),
  supplierJobs: z.array(
    z.strictObject({
      merchantId: z.string(),
      nodeId: z.string(),
      draftOrderGid: z.string(),
      storeDomain: z.string(),
    }),
  ),
});
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;

export const ChaosRequestSchema = z.strictObject({
  scenario: z.enum([
    "supplier_offline",
    "inventory_zero",
    "price_spike",
    "lead_time_delay",
    "conflicting_document",
  ]),
  orderId: z.string().optional(),
  merchantId: z.string().optional(),
});
export type ChaosRequest = z.infer<typeof ChaosRequestSchema>;

export const ChaosReceiptSchema = z.strictObject({
  scenario: ChaosRequestSchema.shape.scenario,
  applied: z.boolean(),
  reversible: z.boolean(),
  eventId: z.uuid(),
});
export type ChaosReceipt = z.infer<typeof ChaosReceiptSchema>;

export const OrderSessionStateSchema = z.enum([
  "REQUESTED",
  "COMPILING_INTENT",
  "NEEDS_CLARIFICATION",
  "INTENT_COMPILED",
  "DISCOVERING",
  "CANDIDATES_READY",
  "QUOTING",
  "QUOTED",
  "SOLVING",
  "PLAN_VALIDATED",
  "PLAN_UNSAT",
  "AWAITING_APPROVAL",
  "EXECUTING",
  "SKU_CREATED",
  "SUPPLIER_JOBS_CREATED",
  "CUSTOMER_ORDER_CREATED",
  "COMPLETED",
  "AT_RISK",
  "RECOVERING",
  "NEEDS_HUMAN",
  "FAILED",
  "CANCELLED",
]);
export type OrderSessionState = z.infer<typeof OrderSessionStateSchema>;

export const OrderSessionSnapshotSchema = z.strictObject({
  orderId: z.string().min(1),
  traceId: z.string().min(1),
  state: OrderSessionStateSchema,
  revision: z.number().int().nonnegative(),
  intentVersion: z.number().int().nonnegative(),
  planGeneration: z.number().int().nonnegative(),
  intent: ProductIntentDraftSchema.nullable(),
  candidates: z.array(CandidateCapabilitySchema),
  quotes: z.array(QuoteResponseSchema),
  activePlan: ProductionPlanSchema.nullable(),
  executionReceipt: ExecutionReceiptSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  eventCursor: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OrderSessionSnapshot = z.infer<typeof OrderSessionSnapshotSchema>;

export const ApiErrorSchema = z.strictObject({
  code: z.enum([
    "VALIDATION_ERROR",
    "CONFLICT",
    "STALE_VERSION",
    "NOT_FOUND",
    "PROVIDER_TIMEOUT",
    "PROVIDER_AUTH",
    "RATE_LIMITED",
    "MODEL_REFUSAL",
    "INCOMPLETE_MODEL_OUTPUT",
    "SOLVER_UNSAT",
    "INVALID_TRANSITION",
    "CHAOS_DISABLED",
    "INTERNAL",
  ]),
  message: z.string(),
  traceId: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

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
    "orchestrator",
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

export const ProviderStatusSchema = z.object({
  name: z.enum(["openai", "backboard", "shopify", "tiger", "rox", "solver"]),
  mode: z.enum(["live", "demo", "unavailable"]),
  status: z.enum(["ready", "degraded", "unavailable"]),
  detail: z.string(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const MerchantTwinSummarySchema = z.object({
  merchantId: z.string(),
  name: z.string(),
  status: z.enum(["online", "offline", "unknown"]),
  capabilities: z.array(CandidateCapabilitySchema),
  claims: z.array(CanonicalClaimSchema),
  memories: z.array(MerchantMemoryCardEntrySchema),
  policies: z.array(z.string()),
  documents: z.array(
    z.object({
      documentId: z.string(),
      name: z.string(),
      status: z.string(),
    }),
  ),
  assistantId: z.string().optional(),
});
export type MerchantTwinSummary = z.infer<typeof MerchantTwinSummarySchema>;

export const OperationsMetricsSchema = z.object({
  orderCount: z.number().int().nonnegative(),
  validatedPlanCount: z.number().int().nonnegative(),
  committedOrderCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  reservationCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  recoveriesCompleted: z.number().int().nonnegative(),
  eventCounts: z.array(
    z.object({
      eventType: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
});
export type OperationsMetrics = z.infer<typeof OperationsMetricsSchema>;

export const MarketplaceSnapshotSchema = z.object({
  generatedAt: z.iso.datetime(),
  mode: z.enum(["live", "demo", "hybrid"]),
  providers: z.array(ProviderStatusSchema),
  merchants: z.array(MerchantTwinSummarySchema),
  metrics: OperationsMetricsSchema,
  recentEvents: z.array(MoleculeEventSchema),
});
export type MarketplaceSnapshot = z.infer<typeof MarketplaceSnapshotSchema>;

export const ActionIdSchema = z.string().min(1).max(160);
export const MessageSubmissionSchema = CompileIntentRequestSchema.pick({
  text: true,
  correction: true,
})
  .extend({
    locale: z.string().default("en-CA"),
    timeZone: z.string().default("UTC"),
    assets: z.array(AssetRefSchema).default([]),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strip();
export type MessageSubmission = z.infer<typeof MessageSubmissionSchema>;
export const ProjectListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(100).default(""),
  cursor: z.string().min(1).max(512).optional(),
});
export type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>;
export const ProjectSummarySchema = z.strictObject({
  orderId: z.string().min(1),
  title: z.string(),
  state: OrderSessionStateSchema,
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export const ProjectListSchema = z.strictObject({
  projects: z.array(ProjectSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ProjectList = z.infer<typeof ProjectListSchema>;

export const ProductionMessageSchema = z.strictObject({
  messageId: ActionIdSchema,
  orderId: z.string().min(1),
  source: z.enum(["web", "desktop", "unknown"]),
  text: z.string().min(1),
  assets: z.array(AssetRefSchema),
  correction: CompileIntentRequestSchema.shape.correction.optional(),
  acceptedAt: z.iso.datetime(),
  acceptedRevision: z.number().int().nonnegative(),
  planGeneration: z.number().int().nonnegative(),
});
export type ProductionMessage = z.infer<typeof ProductionMessageSchema>;
export const MessageOutcomeSchema = z.strictObject({
  messageId: ActionIdSchema,
  status: z.enum(["pending", "succeeded", "failed", "superseded", "cancelled"]),
  resultRevision: z.number().int().nonnegative().nullable(),
  reason: z.string().nullable(),
});
export const MessageHistoryQuerySchema = z.object({
  afterCursor: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const MessageHistorySchema = z.strictObject({
  messages: z.array(
    ProductionMessageSchema.extend({
      cursor: z.number().int().positive(),
      outcome: MessageOutcomeSchema,
    }),
  ),
  nextCursor: z.number().int().nonnegative().nullable(),
});
export type MessageHistory = z.infer<typeof MessageHistorySchema>;

export const ActionStatusQuerySchema = z.object({
  key: ActionIdSchema,
  kind: z.enum(["message", "desktop", "approve", "upload"]).default("message"),
});
export type ActionStatusQuery = z.infer<typeof ActionStatusQuerySchema>;
export const ActionStatusSchema = z.strictObject({
  orderId: z.string().min(1),
  key: ActionIdSchema,
  kind: ActionStatusQuerySchema.shape.kind,
  status: z.enum(["unknown", "pending", "succeeded", "failed", "superseded"]),
  resultRevision: z.number().int().nonnegative().nullable(),
  resultState: OrderSessionStateSchema.nullable(),
  error: ApiErrorSchema.nullable(),
  automaticRetryAllowed: z.literal(false),
});
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

export const ProjectCapabilitiesSchema = z.strictObject({
  canSubmitMessage: z.boolean(),
  canCancelPlanning: z.boolean(),
  canApprove: z.boolean(),
  requiresOperator: z.boolean(),
  reason: z.string().nullable(),
});
export type ProjectCapabilities = z.infer<typeof ProjectCapabilitiesSchema>;
export const ProjectCapabilitiesEnvelopeSchema = z.strictObject({
  orderId: z.string(),
  revision: z.number().int().nonnegative(),
  capabilities: ProjectCapabilitiesSchema,
});

export const DesktopConstraintSchema = ConstraintSchema.omit({
  constraintId: true,
}).extend({
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  hard: z.boolean(),
});
export const DesktopCommandSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("start_project"),
    args: z.object({ intent: z.string().min(1).max(20_000) }),
  }),
  z.object({
    name: z.literal("add_constraint"),
    args: z.object({ constraint: DesktopConstraintSchema }),
  }),
  z.object({
    name: z.literal("remove_constraint"),
    args: z.object({ constraintId: z.string().min(1) }),
  }),
  z.object({
    name: z.literal("attach_context"),
    args: z.object({ contextId: z.uuid() }),
  }),
  z.object({ name: z.literal("get_project_status"), args: z.object({}) }),
  z.object({ name: z.literal("get_active_plan"), args: z.object({}) }),
  z.object({
    name: z.literal("explain_decision"),
    args: z.object({ decisionId: z.string().optional() }),
  }),
  z.object({ name: z.literal("request_recompile"), args: z.object({}) }),
  z.object({
    name: z.literal("approve_action"),
    args: z.object({
      planId: z.string(),
      intentVersion: z.number().int().positive(),
    }),
  }),
  z.object({ name: z.literal("cancel_project"), args: z.object({}) }),
  z.object({ name: z.literal("open_command_center"), args: z.object({}) }),
]);
export type DesktopCommand = z.infer<typeof DesktopCommandSchema>;
export const DesktopActionSchema = z.object({
  actionId: ActionIdSchema,
  command: DesktopCommandSchema,
  originalText: z.string().min(1).max(20_000).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  locale: z.string().default("en-CA"),
  timeZone: z.string().default("UTC"),
});
export const DesktopResultSchema = z.object({
  project: OrderSessionSnapshotSchema,
  contexts: z.array(AssetRefSchema),
});
export type DesktopResult = z.infer<typeof DesktopResultSchema>;
export const RealtimeSessionSchema = z.object({
  value: z.string().min(1),
  expiresAt: z.number().optional(),
});
export const ContextUploadSchema = z.object({
  actionId: ActionIdSchema,
  name: z.string().min(1).max(200),
  mimeType: z.enum([
    "image/png",
    "image/jpeg",
    "application/pdf",
    "text/csv",
    "text/plain",
    "application/json",
  ]),
});
export const MAX_CONTEXT_BYTES = 10 * 1024 * 1024;
export const ContextReceiptSchema = z.object({
  contextId: z.uuid(),
  asset: AssetRefSchema,
});
export type ContextReceipt = z.infer<typeof ContextReceiptSchema>;

export {
  deriveProjectCapabilities,
  hasUncompiledContext,
  isPlanningState,
} from "./capabilities.js";
