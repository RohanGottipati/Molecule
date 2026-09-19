import type { ToolCallContext, ToolDefinition } from "@molecule/backboard";
import {
  CanonicalClaimSchema,
  MerchantCapabilitySchema,
  QuoteResponseSchema,
  type ConstraintSchema,
  type MerchantCapability,
  type QuoteRequest,
  type QuoteResponse,
} from "@molecule/contracts";
import { z } from "zod";

type Constraint = z.infer<typeof ConstraintSchema>;

function matches(actual: unknown, constraint: Constraint): boolean {
  const expected = constraint.value;
  const equal = (a: unknown, b: unknown) =>
    typeof a === "string" && typeof b === "string"
      ? a.toLowerCase() === b.toLowerCase()
      : JSON.stringify(a) === JSON.stringify(b);
  switch (constraint.operator) {
    case "eq":
      return equal(actual, expected);
    case "neq":
      return !equal(actual, expected);
    case "in":
      return (
        Array.isArray(expected) &&
        expected.some((value) => equal(actual, value))
      );
    case "contains":
      return Array.isArray(actual)
        ? actual.some((value) => equal(value, expected))
        : typeof actual === "string" &&
            typeof expected === "string" &&
            actual.toLowerCase().includes(expected.toLowerCase());
    case "not_contains":
      return !matches(actual, { ...constraint, operator: "contains" });
    case "lt":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual < expected
      );
    case "lte":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual <= expected
      );
    case "gt":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual > expected
      );
    case "gte":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual >= expected
      );
  }
}

function attributeValues(
  capability: MerchantCapability,
  field: string,
): unknown[] | undefined {
  const parts = field.split(".");
  const attribute = parts.at(-1)!;
  const scope = parts.length > 1 ? parts[0] : undefined;
  const ports = capability.produces.filter(
    (port) =>
      !scope ||
      [
        port.name,
        port.kind,
        port.attributes.product,
        port.attributes.outputId,
      ].includes(scope),
  );
  if (scope && ports.length === 0) return undefined;
  if (
    capability.kind !== "SUPPLY" &&
    ["material", "color", "diet", "product"].includes(attribute)
  )
    return undefined;
  return ports.map((port) => port.attributes[attribute]);
}

export async function groundQuote(
  request: QuoteRequest,
  tools: ToolDefinition[],
  context: ToolCallContext,
  now: Date,
  signal: AbortSignal,
): Promise<{ quote: QuoteResponse; evidence: string[] }> {
  const evidence: string[] = [];
  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const tool = tools.find(
      (candidate) => candidate.name === name && candidate.risk === "read",
    );
    if (!tool) throw new Error(`Missing canonical tool ${name}`);
    const value = await tool.handler(tool.parameters.parse(args), context);
    signal.throwIfAborted();
    evidence.push(name);
    return value;
  }
  const decline = (explanation: string) => ({
    quote: QuoteResponseSchema.parse({
      merchantId: request.merchantId,
      capabilityId: request.capabilityId,
      status: "DECLINE",
      currency: request.currency,
      confidence: 0,
      explanation,
    }),
    evidence,
  });
  const cap = MerchantCapabilitySchema.safeParse(
    await call("get_capability_policy", { capabilityId: request.capabilityId }),
  );
  if (
    !cap.success ||
    cap.data.merchantId !== request.merchantId ||
    cap.data.capabilityId !== request.capabilityId
  ) {
    return decline(
      "Canonical capability is unknown or belongs to another merchant.",
    );
  }
  const capability = cap.data;
  const { claims } = z
    .object({ claims: z.array(CanonicalClaimSchema) })
    .parse(await call("get_canonical_claims", { fields: [] }));
  const relevant = claims.filter(
    (claim) =>
      capability.sourceClaimIds.includes(claim.claimId) ||
      request.relevantClaimFields.includes(claim.field) ||
      request.constraints.some(
        (constraint) =>
          constraint.field === claim.field ||
          constraint.field.split(".").at(-1) === claim.field,
      ) ||
      /capacity|price|pricing|policy|lead.?time|inventory|available|offline/i.test(
        claim.field,
      ),
  );
  if (
    capability.sourceClaimIds.some(
      (id) =>
        !claims.some(
          (claim) =>
            claim.claimId === id && claim.resolutionStatus === "active",
        ),
    )
  ) {
    return decline(
      "Capability source evidence is missing or no longer active.",
    );
  }
  if (
    relevant.some(
      (claim) =>
        claim.merchantId !== request.merchantId ||
        ["unknown", "conflicted", "quarantined"].includes(
          claim.resolutionStatus,
        ),
    )
  ) {
    return decline(
      "Relevant canonical evidence is unknown, conflicted or quarantined.",
    );
  }
  for (const field of new Set(relevant.map((claim) => claim.field))) {
    const values = new Set(
      relevant
        .filter(
          (claim) =>
            claim.field === field && claim.resolutionStatus === "active",
        )
        .map((claim) => JSON.stringify(claim.normalizedValue)),
    );
    if (values.size > 1)
      return decline("Canonical evidence has inconsistent active values.");
  }
  if (
    request.relevantClaimFields.some(
      (field) =>
        !relevant.some(
          (claim) =>
            claim.field === field && claim.resolutionStatus === "active",
        ),
    )
  ) {
    return decline("A requested canonical field has no active evidence.");
  }
  if (
    relevant.some(
      (claim) =>
        claim.resolutionStatus === "active" &&
        ((claim.field === "offline" && claim.normalizedValue === true) ||
          (claim.field === "available" && claim.normalizedValue === false)),
    )
  )
    return decline("Merchant is offline.");
  const capacity = z
    .object({ available: z.number().nonnegative() })
    .parse(await call("get_capacity", { capabilityId: request.capabilityId }));
  const calculated = QuoteResponseSchema.parse(
    await call("calculate_quote", {
      capabilityId: request.capabilityId,
      quantity: request.quantity,
    }),
  );
  if (calculated.status !== "CAN_ACCEPT")
    return { quote: calculated, evidence };
  if (
    capability.capacity.available === undefined ||
    request.quantity >
      Math.min(capability.capacity.available, capacity.available)
  ) {
    return decline(
      "Verified current capacity does not cover the requested quantity.",
    );
  }
  if (capability.pricing.currency !== request.currency)
    return decline("Canonical price currency differs from the order.");
  for (const claim of relevant.filter(
    (item) => item.resolutionStatus === "active",
  )) {
    if (
      ["capacity", "capacity.available", "capacity_per_day"].includes(
        claim.field,
      ) &&
      (typeof claim.normalizedValue !== "number" ||
        claim.normalizedValue < request.quantity)
    ) {
      return decline(
        "Active capacity evidence does not cover the requested quantity.",
      );
    }
    if (
      ["unitPrice", "pricing.unitPrice", "unit_price"].includes(claim.field) &&
      claim.normalizedValue !== calculated.unitPrice
    ) {
      return decline(
        "Canonical capability price disagrees with active price evidence.",
      );
    }
  }
  let stockLimit = Number.POSITIVE_INFINITY;
  if (capability.kind === "SUPPLY") {
    const sku =
      capability.produces.find(
        (port) => typeof port.attributes.sku === "string",
      )?.attributes.sku ?? capability.capabilityId;
    const inventory = z
      .object({
        found: z.boolean(),
        available: z.number().nonnegative(),
        merchantId: z.string().optional(),
        sku: z.string(),
      })
      .parse(await call("get_inventory", { sku }));
    if (
      !inventory.found ||
      inventory.merchantId !== request.merchantId ||
      inventory.sku !== sku ||
      inventory.available < request.quantity
    ) {
      return decline(
        "Verified inventory does not cover the requested quantity.",
      );
    }
    stockLimit = inventory.available;
  }
  for (const constraint of [...request.constraints, ...capability.hardRules]) {
    const values =
      constraint.field === "quantity"
        ? [request.quantity]
        : constraint.field === "currency"
          ? [request.currency]
          : attributeValues(capability, constraint.field);
    if (values === undefined) {
      if (capability.hardRules.includes(constraint))
        return decline(
          `Merchant policy ${constraint.field} requires verified input facts.`,
        );
      continue;
    }
    const active = relevant.filter(
      (claim) =>
        (claim.field === constraint.field ||
          claim.field === constraint.field.split(".").at(-1)) &&
        claim.resolutionStatus === "active",
    );
    const facts = active.length
      ? [
          ...values.filter((value) => value !== undefined),
          ...active.map((claim) => claim.normalizedValue),
        ]
      : values;
    if (
      facts.length === 0 ||
      facts.some((value) => value === undefined || !matches(value, constraint))
    ) {
      return decline(
        `Canonical facts do not establish constraint ${constraint.field}.`,
      );
    }
  }
  const duration = capability.leadTime.max;
  const completion = new Date(now);
  if (capability.leadTime.unit === "business_hours") {
    const days = Math.ceil(duration / 8);
    if (days > 0) {
      const day = completion.getUTCDay();
      if (day === 0 || day === 6)
        completion.setUTCDate(completion.getUTCDate() - (day === 0 ? 2 : 1));
      const weekends = Math.floor((completion.getUTCDay() - 1 + days) / 5);
      completion.setUTCDate(completion.getUTCDate() + days + 2 * weekends);
    }
  } else {
    const factor = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[
      capability.leadTime.unit
    ];
    completion.setTime(completion.getTime() + duration * factor);
  }
  if (!Number.isFinite(completion.getTime()))
    return decline("Canonical lead time is outside the supported date range.");
  if (request.deadline && completion.getTime() > Date.parse(request.deadline))
    return decline("Canonical lead time exceeds the requested deadline.");
  const minimum = capability.pricing.minimumTotal ?? 0;
  return {
    quote: QuoteResponseSchema.parse({
      ...calculated,
      setupFee: Math.max(
        calculated.setupFee,
        minimum - (calculated.unitPrice ?? 0) * request.quantity,
      ),
      maxQuantity: Math.floor(
        Math.min(
          capability.quantity.max,
          capacity.available,
          capability.capacity.available,
          stockLimit,
        ),
      ),
      completionEstimate: completion.toISOString(),
      explanation:
        "Canonical tools verified price, setup fee, current capacity, policy and applicable constraints. Advisory quote; only the solver certifies plan feasibility.",
    }),
    evidence,
  };
}
