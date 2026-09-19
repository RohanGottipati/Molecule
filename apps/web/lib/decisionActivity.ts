import type { MoleculeEvent } from "@molecule/contracts";
import { humanize } from "./workspace";

const titles: Record<string, string> = {
  "order.created": "Project created",
  "intent.received": "Brief received",
  "intent.compiled": "Brief compiled into requirements",
  "intent.unsupported": "Brief could not be supported",
  "intent.clarification.required": "More detail requested",
  "candidate.search.completed": "Supplier search returned",
  "merchant.quote.fanout.completed": "Supplier quotes collected",
  "merchant.quote.timeout": "Supplier quote was not confirmed",
  "merchant.job.accepted": "Supplier acceptance recorded",
  "merchant.job.rejected": "Supplier job rejected",
  "merchant.job.cancelled": "Supplier job cancellation recorded",
  "merchant.capacity.reserved": "Supplier capacity reserved",
  "merchant.capacity.released": "Supplier reservation released",
  "reality.claim.resolved": "Source field resolved",
  "reality.claim.conflicted": "Sources disagree on a field",
  "reality.claim.unknown": "Source field remains unknown",
  "solver.valid": "Solver found a feasible plan",
  "solver.unsat": "Solver could not satisfy all requirements",
  "execution.approval.requested": "Plan is awaiting approval",
  "execution.started": "Commerce execution started",
  "execution.failed": "Commerce execution needs review",
  "execution.incomplete": "Some commerce actions remain unconfirmed",
  "shopify.product.created": "Product record created",
  "shopify.supplier_job.created": "Supplier job records created",
  "shopify.customer_order.created": "Customer order record created",
  "order.completed": "Commerce records and supplier acceptance confirmed",
  "order.needs_human": "Operator decision required",
  "supplier.offline": "Supplier marked offline",
  "plan.invalidated": "Previous plan invalidated",
  "recovery.started": "Supplier recovery started",
  "recovery.plan.ready": "Replacement plan is ready for review",
  "recovery.approval.required": "Replacement requires approval",
  "recovery.completed": "Replacement commerce execution confirmed",
  "recovery.failed": "Supplier recovery needs review",
  "project.cancelled": "Project cancelled",
  "workflow.failed": "Workflow stopped",
  "context.attached": "Context attached to project",
  "constraint.added": "Requirement added",
  "constraint.removed": "Requirement removed",
};

const scalarKeys = [
  "state",
  "status",
  "count",
  "code",
  "errorCode",
  "intentVersion",
  "planGeneration",
  "capabilityId",
  "actionId",
  "actionKey",
  "providerRef",
  "merchantId",
  "nodeId",
  "previousPlanId",
  "replacementPlanId",
  "resultIntentVersion",
  "resultGeneration",
  "costDelta",
  "currency",
  "completionDeltaHours",
  "deadlinePreserved",
  "approvalRequired",
  "productGid",
  "draftOrderGid",
  "field",
  "winningClaimId",
] as const;

const reasonEvents = new Set([
  "intent.unsupported",
  "plan.invalidated",
  "recovery.failed",
  "merchant.job.rejected",
  "merchant.job.cancelled",
]);

const resolutionEvents = new Set([
  "reality.claim.resolved",
  "reality.claim.conflicted",
  "reality.claim.unknown",
]);

function scalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
}

export function activityReason(event: MoleculeEvent): string | undefined {
  if (
    resolutionEvents.has(event.eventType) &&
    typeof event.payload.explanation === "string"
  )
    return event.payload.explanation;
  if (
    reasonEvents.has(event.eventType) &&
    typeof event.payload.reason === "string"
  )
    return event.payload.reason;
  if (
    ["execution.failed", "workflow.failed"].includes(event.eventType) &&
    typeof event.payload.code === "string"
  )
    return `Reported error: ${event.payload.code}`;
  if (event.eventType === "merchant.quote.timeout")
    return "No quote was confirmed before the request ended. Other returned quotes may still be evaluated.";
  if (event.eventType === "solver.valid")
    return "Feasibility is confirmed for this plan. This does not confirm commerce execution.";
  if (event.eventType === "order.completed")
    return "This records commerce execution, not payment, manufacture or delivery.";
  if (
    event.eventType === "intent.clarification.required" &&
    Array.isArray(event.payload.questions)
  )
    return (
      event.payload.questions
        .filter((item): item is string => typeof item === "string")
        .join(" ") || undefined
    );
  return undefined;
}

export function activityTitle(event: MoleculeEvent): string {
  return titles[event.eventType] ?? humanize(event.eventType);
}

export function meaningfulActivity(event: MoleculeEvent): boolean {
  return (
    event.severity !== "DEBUG" &&
    (Object.hasOwn(titles, event.eventType) ||
      ["WARN", "ERROR"].includes(event.severity))
  );
}

export function activityPayload(event: MoleculeEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of scalarKeys)
    if (scalar(event.payload[key])) result[key] = event.payload[key];
  if (resolutionEvents.has(event.eventType)) {
    if (typeof event.payload.explanation === "string")
      result.explanation = event.payload.explanation;
    if (scalar(event.payload.value)) result.value = event.payload.value;
  }
  if (
    reasonEvents.has(event.eventType) &&
    typeof event.payload.reason === "string"
  )
    result.reason = event.payload.reason;
  if (
    event.eventType === "intent.clarification.required" &&
    Array.isArray(event.payload.questions)
  )
    result.questions = event.payload.questions.filter(
      (item): item is string => typeof item === "string",
    );
  if (Array.isArray(event.payload.actions))
    result.actions = event.payload.actions.map((action: unknown) => {
      if (!action || typeof action !== "object") return {};
      return Object.fromEntries(
        Object.entries(action).filter(
          ([key, value]) =>
            [
              "actionKey",
              "kind",
              "status",
              "providerRef",
              "errorCode",
            ].includes(key) && scalar(value),
        ),
      );
    });
  return result;
}

export function visibleActivity(
  events: MoleculeEvent[],
  mode: "decisions" | "all",
  limit: number,
) {
  const filtered = mode === "all" ? events : events.filter(meaningfulActivity);
  const count = Math.max(0, Math.floor(limit));
  return count ? filtered.slice(-count).reverse() : [];
}
