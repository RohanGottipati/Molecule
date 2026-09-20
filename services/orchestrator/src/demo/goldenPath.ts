import type {
  MoleculeEvent,
  OrderSessionSnapshot,
} from "@molecule/contracts";

/**
 * What the canonical golden-path brief must produce when it runs against the
 * synthetic demo catalog and the real CP-SAT solver. The solver remains the
 * feasibility authority; this only pins the outcome a demonstration expects.
 */
export const GOLDEN_PATH_EXPECTATION = {
  quantity: 200,
  currency: "CAD",
  budgetMax: 7000,
  outputIds: ["hoodie", "bottle", "snacks"],
  transformationIds: ["embroidery", "engraving", "assembly", "fulfillment"],
  candidateCapabilityIds: [
    "supply-base",
    "supply-backup",
    "supply-bottle",
    "supply-snacks",
    "transform-thread",
    "transform-needle",
    "transform-laser",
    "assemble-pack",
    "fulfill-pack",
  ],
  planNodes: {
    "supply-base": "base-goods",
    "supply-bottle": "base-goods",
    "supply-snacks": "snack-box",
    "transform-thread": "thread-forge",
    "transform-laser": "laser-lab",
    "assemble-pack": "pack-ship",
    "fulfill-pack": "pack-ship",
  },
  edgeCount: 6,
  totalCost: 6380,
  executionActions: 9,
  eventOrder: [
    "intent.received",
    "intent.compiled",
    "candidate.search.started",
    "candidate.search.completed",
    "merchant.quote.fanout.started",
    "merchant.quote.fanout.completed",
    "solver.started",
    "solver.valid",
    "execution.approval.requested",
    "execution.started",
    "shopify.product.created",
    "shopify.supplier_job.created",
    "shopify.customer_order.created",
    "order.completed",
  ],
} as const;

export type GoldenPathPhase = "planned" | "completed";

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/**
 * Returns human-readable deviations from the golden path; an empty list means
 * the snapshot matches the expected best-case run for the given phase.
 */
export function goldenPathDeviations(
  snapshot: OrderSessionSnapshot,
  phase: GoldenPathPhase,
  options: { strictPlan?: boolean } = {},
): string[] {
  const expected = GOLDEN_PATH_EXPECTATION;
  const issues: string[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) issues.push(message);
  };
  const intent = snapshot.intent;
  check(intent !== null, "intent was not compiled");
  if (intent) {
    check(
      intent.ambiguityFlags.length === 0,
      `compiler asked ${intent.ambiguityFlags.length} clarification question(s)`,
    );
    check(intent.quantity === expected.quantity, `quantity ${intent.quantity}`);
    check(intent.currency === expected.currency, `currency ${intent.currency}`);
    check(intent.budgetMax === expected.budgetMax, `budget ${intent.budgetMax}`);
    check(
      JSON.stringify(intent.desiredOutputs.map((o) => o.outputId)) ===
        JSON.stringify(expected.outputIds),
      `outputs ${intent.desiredOutputs.map((o) => o.outputId).join(",")}`,
    );
    check(
      JSON.stringify(intent.transformations.map((t) => t.transformationId)) ===
        JSON.stringify(expected.transformationIds),
      `transformations ${intent.transformations.map((t) => t.transformationId).join(",")}`,
    );
  }
  check(snapshot.lastErrorCode === null, `error ${snapshot.lastErrorCode}`);
  check(
    snapshot.state === (phase === "planned" ? "AWAITING_APPROVAL" : "COMPLETED"),
    `state ${snapshot.state}`,
  );
  if (options.strictPlan ?? true) {
    check(
      JSON.stringify(
        sorted(snapshot.candidates.map((c) => c.capabilityId)),
      ) === JSON.stringify(sorted(expected.candidateCapabilityIds)),
      `candidates ${sorted(snapshot.candidates.map((c) => c.capabilityId)).join(",")}`,
    );
    check(
      snapshot.quotes.length === expected.candidateCapabilityIds.length &&
        snapshot.quotes.every((quote) => quote.status === "CAN_ACCEPT"),
      `quotes ${snapshot.quotes.map((q) => `${q.capabilityId}:${q.status}`).join(",")}`,
    );
  }
  const plan = snapshot.activePlan;
  check(plan !== null, "no active plan");
  if (plan) {
    check(plan.status === "VALID", `plan ${plan.status}`);
    check(
      plan.constraintResults.every((result) => result.satisfied),
      `unsatisfied ${plan.constraintResults
        .filter((r) => !r.satisfied)
        .map((r) => r.constraintId)
        .join(",")}`,
    );
    if (intent?.budgetMax)
      check(
        plan.totalCost <= intent.budgetMax,
        `cost ${plan.totalCost} exceeds budget ${intent.budgetMax}`,
      );
    if (intent?.deadline && plan.estimatedCompletion)
      check(
        plan.estimatedCompletion <= intent.deadline,
        `completion ${plan.estimatedCompletion} after deadline ${intent.deadline}`,
      );
    if (options.strictPlan ?? true) {
      const nodes = Object.fromEntries(
        plan.nodes.map((node) => [node.capabilityId, node.merchantId]),
      );
      check(
        JSON.stringify(Object.entries(nodes).sort()) ===
          JSON.stringify(Object.entries(expected.planNodes).sort()),
        `plan nodes ${Object.entries(nodes)
          .map(([c, m]) => `${c}@${m}`)
          .join(",")}`,
      );
      check(
        plan.edges.length === expected.edgeCount,
        `edges ${plan.edges.length}`,
      );
      check(plan.totalCost === expected.totalCost, `cost ${plan.totalCost}`);
    }
  }
  if (phase === "completed") {
    const receipt = snapshot.executionReceipt;
    check(receipt !== null, "no execution receipt");
    if (receipt) {
      check(
        receipt.actions.every((action) => action.status === "SUCCEEDED"),
        `actions ${receipt.actions.map((a) => `${a.kind}:${a.status}`).join(",")}`,
      );
      if (options.strictPlan ?? true)
        check(
          receipt.actions.length === expected.executionActions,
          `action count ${receipt.actions.length}`,
        );
      check(
        receipt.compositeProduct !== undefined,
        "composite product missing",
      );
      check(receipt.customerOrder !== undefined, "customer order missing");
      check(
        receipt.supplierJobs.length === (plan?.nodes.length ?? 0),
        `supplier jobs ${receipt.supplierJobs.length}`,
      );
    }
  }
  return issues;
}

/** Event types that must appear, in this relative order, for a completed run. */
export function goldenPathEventDeviations(
  events: Pick<MoleculeEvent, "eventType">[],
): string[] {
  const types = events.map((event) => event.eventType);
  const issues: string[] = [];
  let cursor = -1;
  for (const expected of GOLDEN_PATH_EXPECTATION.eventOrder) {
    const index = types.indexOf(expected, cursor + 1);
    if (index === -1) issues.push(`missing ${expected} after position ${cursor}`);
    else cursor = index;
  }
  for (const unwanted of [
    "intent.clarification.required",
    "intent.unsupported",
    "solver.unsat",
    "order.needs_human",
    "workflow.failed",
    "execution.failed",
    "merchant.quote.timeout",
  ])
    if (types.includes(unwanted)) issues.push(`unexpected ${unwanted}`);
  return issues;
}
