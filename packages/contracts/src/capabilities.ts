import type {
  AssetRef,
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
  contexts: readonly AssetRef[] = [],
): ProjectCapabilities {
  const uncompiled = hasUncompiledContext(session, contexts);
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
      session.activePlan.intentVersion === session.intentVersion &&
      !uncompiled,
    requiresOperator,
    reason: executionEvidence
      ? "Execution has started. Planning cancellation and corrections cannot undo provider effects. Retain receipts and ask the operator to reconcile uncertain work."
      : uncompiled
        ? "Submit a brief update to compile the attached context before approval."
        : null,
  };
}

export function hasUncompiledContext(
  session: OrderSessionSnapshot | null,
  contexts: readonly AssetRef[],
): boolean {
  return contexts.some(
    (asset) =>
      !session?.intent?.assets.some(
        (compiled) =>
          compiled.assetId === asset.assetId &&
          compiled.checksum === asset.checksum &&
          (asset.checksum !== undefined || compiled.url === asset.url),
      ),
  );
}
