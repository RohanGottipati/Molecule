import type {
  OrderSessionSnapshot,
  OrderSessionState,
  ProjectCapabilities,
} from "./index.js";

const planningStates: readonly OrderSessionState[] = [
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
  "NEEDS_HUMAN",
  "FAILED",
];

export function isPlanningState(state: OrderSessionState): boolean {
  return planningStates.includes(state);
}

export function deriveProjectCapabilities(
  session: OrderSessionSnapshot,
  executionStarted = false,
): ProjectCapabilities {
  const executionEvidence =
    executionStarted ||
    session.executionReceipt !== null ||
    [
      "EXECUTING",
      "SKU_CREATED",
      "SUPPLIER_JOBS_CREATED",
      "CUSTOMER_ORDER_CREATED",
      "COMPLETED",
    ].includes(session.state) ||
    ["EXECUTION_UNCERTAIN", "EXECUTION_INCOMPLETE"].includes(
      session.lastErrorCode ?? "",
    );
  const requiresOperator =
    executionEvidence &&
    ["NEEDS_HUMAN", "FAILED", "AT_RISK"].includes(session.state);
  return {
    canSubmitMessage: isPlanningState(session.state) && !executionEvidence,
    canCancelPlanning: isPlanningState(session.state) && !executionEvidence,
    canApprove:
      session.state === "AWAITING_APPROVAL" &&
      session.activePlan?.status === "VALID" &&
      session.activePlan.intentVersion === session.intentVersion,
    requiresOperator,
    reason: executionEvidence
      ? "Execution has started. Planning cancellation and corrections cannot undo provider effects. Retain receipts and ask the operator to reconcile uncertain work."
      : null,
  };
}
