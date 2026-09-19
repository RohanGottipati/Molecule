import type { MoleculeEvent, OrderSessionSnapshot } from "@molecule/contracts";

export function canApproveDecision(
  order: OrderSessionSnapshot | null,
): boolean {
  const plan = order?.activePlan;
  return Boolean(
    plan &&
    plan.status === "VALID" &&
    plan.orderId === order?.orderId &&
    plan.intentVersion === order?.intentVersion &&
    order?.state === "AWAITING_APPROVAL",
  );
}

export function executionAssessment(
  order: OrderSessionSnapshot,
  events: MoleculeEvent[] = [],
) {
  const receipt = order.executionReceipt;
  const currentReceipt =
    receipt?.planId === order.activePlan?.planId &&
    receipt?.intentVersion === order.intentVersion &&
    receipt?.orderId === order.orderId;
  const executionEvent = events.find(
    (event) =>
      event.orderId === order.orderId &&
      event.planId === order.activePlan?.planId &&
      ["execution.failed", "execution.incomplete"].includes(event.eventType),
  );
  if (
    [
      "EXECUTING",
      "SKU_CREATED",
      "SUPPLIER_JOBS_CREATED",
      "CUSTOMER_ORDER_CREATED",
    ].includes(order.state)
  )
    return "executing" as const;
  if (order.state === "NEEDS_HUMAN") {
    if (receipt || executionEvent || order.activePlan?.status === "VALID")
      return "uncertain" as const;
    return "planning" as const;
  }
  if (order.state === "COMPLETED")
    return currentReceipt &&
      receipt?.compositeProduct &&
      receipt.customerOrder &&
      receipt.supplierJobs.length === order.activePlan?.nodes.length &&
      receipt.actions.length > 0 &&
      receipt.actions.every((action) =>
        ["SUCCEEDED", "COMPENSATED"].includes(action.status),
      )
      ? ("confirmed" as const)
      : ("uncertain" as const);
  if (canApproveDecision(order)) return "awaiting" as const;
  return "planning" as const;
}
