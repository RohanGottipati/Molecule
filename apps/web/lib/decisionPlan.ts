import type { ProductionPlan } from "@molecule/contracts";

export type PlanSelection = {
  planId: string;
  nodeId: string;
  currency: ProductionPlan["currency"];
  historical: boolean;
};

export function planSelection(
  plan: ProductionPlan,
  nodeId: string,
  activePlanId: string,
): PlanSelection {
  return {
    planId: plan.planId,
    nodeId,
    currency: plan.currency,
    historical: plan.planId !== activePlanId,
  };
}

export function nodeEvidenceContext(
  activePlan: ProductionPlan | null,
  node: ProductionPlan["nodes"][number],
  selection?: PlanSelection,
) {
  const currentNode =
    selection?.planId === activePlan?.planId
      ? activePlan?.nodes.find((item) => item.nodeId === selection?.nodeId)
      : !selection
        ? activePlan?.nodes.find((item) => item === node)
        : undefined;
  return {
    node: currentNode ?? node,
    current: Boolean(currentNode),
    currency: currentNode ? activePlan?.currency : selection?.currency,
  };
}
