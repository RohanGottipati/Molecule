import {
  deriveProjectCapabilities,
  isPlanningState,
  type OrderSessionState,
  type ProductionPlan,
} from "@molecule/contracts";

import type { OrderSession } from "./OrderSession.js";

const allowed = new Map<OrderSessionState, Set<OrderSessionState>>([
  ["REQUESTED", new Set(["COMPILING_INTENT", "FAILED"])],
  [
    "COMPILING_INTENT",
    new Set(["NEEDS_CLARIFICATION", "INTENT_COMPILED", "FAILED"]),
  ],
  [
    "NEEDS_CLARIFICATION",
    new Set(["COMPILING_INTENT", "NEEDS_HUMAN", "FAILED"]),
  ],
  ["INTENT_COMPILED", new Set(["DISCOVERING", "COMPILING_INTENT", "FAILED"])],
  [
    "DISCOVERING",
    new Set(["CANDIDATES_READY", "COMPILING_INTENT", "NEEDS_HUMAN", "FAILED"]),
  ],
  [
    "CANDIDATES_READY",
    new Set(["QUOTING", "COMPILING_INTENT", "NEEDS_HUMAN", "FAILED"]),
  ],
  ["QUOTING", new Set(["QUOTED", "COMPILING_INTENT", "NEEDS_HUMAN", "FAILED"])],
  ["QUOTED", new Set(["SOLVING", "COMPILING_INTENT", "NEEDS_HUMAN", "FAILED"])],
  [
    "SOLVING",
    new Set(["PLAN_VALIDATED", "PLAN_UNSAT", "COMPILING_INTENT", "FAILED"]),
  ],
  [
    "PLAN_VALIDATED",
    new Set(["AWAITING_APPROVAL", "COMPILING_INTENT", "AT_RISK", "FAILED"]),
  ],
  ["PLAN_UNSAT", new Set(["NEEDS_HUMAN", "COMPILING_INTENT", "FAILED"])],
  [
    "AWAITING_APPROVAL",
    new Set(["EXECUTING", "COMPILING_INTENT", "AT_RISK", "FAILED"]),
  ],
  ["EXECUTING", new Set(["SKU_CREATED", "AT_RISK", "NEEDS_HUMAN", "FAILED"])],
  ["SKU_CREATED", new Set(["SUPPLIER_JOBS_CREATED", "AT_RISK", "FAILED"])],
  [
    "SUPPLIER_JOBS_CREATED",
    new Set(["CUSTOMER_ORDER_CREATED", "AT_RISK", "FAILED"]),
  ],
  ["CUSTOMER_ORDER_CREATED", new Set(["COMPLETED", "AT_RISK", "FAILED"])],
  ["COMPLETED", new Set(["AT_RISK", "NEEDS_HUMAN"])],
  ["AT_RISK", new Set(["RECOVERING", "NEEDS_HUMAN", "FAILED"])],
  ["RECOVERING", new Set(["INTENT_COMPILED", "NEEDS_HUMAN", "FAILED"])],
  ["NEEDS_HUMAN", new Set(["COMPILING_INTENT", "RECOVERING", "FAILED"])],
  ["FAILED", new Set(["COMPILING_INTENT", "RECOVERING"])],
]);

export class InvalidTransitionError extends Error {
  constructor(from: OrderSessionState, to: OrderSessionState) {
    super(`Invalid order-session transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function transition(
  session: OrderSession,
  to: OrderSessionState,
  options: { solverPlan?: ProductionPlan } = {},
): OrderSession {
  if (!allowed.get(session.state)?.has(to)) {
    if (
      to !== "CANCELLED" ||
      !deriveProjectCapabilities(session).canCancelPlanning
    ) {
      throw new InvalidTransitionError(session.state, to);
    }
  }
  if (to === "PLAN_VALIDATED" && options.solverPlan?.status !== "VALID") {
    throw new InvalidTransitionError(session.state, to);
  }
  if (to === "EXECUTING") {
    if (
      session.activePlan?.status !== "VALID" ||
      session.activePlan.intentVersion !== session.intentVersion
    ) {
      throw new InvalidTransitionError(session.state, to);
    }
  }
  return {
    ...session,
    state: to,
    revision: session.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

export function canAcceptCorrection(state: OrderSessionState): boolean {
  return isPlanningState(state);
}
