import type { ProductionPlan } from "@molecule/contracts";

export type PlanNodeKind = ProductionPlan["nodes"][number]["kind"];

export const kindColorVar: Record<PlanNodeKind, string> = {
  SUPPLY: "var(--mol-cyan)",
  TRANSFORM: "var(--mol-primary)",
  ASSEMBLE: "var(--mol-violet)",
  FULFILL: "var(--mol-success)",
};
