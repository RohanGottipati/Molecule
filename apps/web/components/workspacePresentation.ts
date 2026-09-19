import type {
  MoleculeEvent,
  OrderSessionSnapshot,
  ProductionPlan,
  ProjectSummary,
  AssetRef,
} from "@molecule/contracts";
import { isUnresolved, type DraftScope } from "../lib/persistence";
import type { ConversationEntry, Workspace } from "../lib/useWorkspace";
import { executionAssessment } from "../lib/decisionExecution";
import type { PlanSelection } from "../lib/decisionPlan";
import { planDelta, processingStates, stateLabels } from "../lib/workspace";

export const productionExample =
  "Make 200 premium black onboarding kits by next Friday under CAD 7,000. No leather. Each kit needs a hoodie with logo embroidery, a named engraved bottle, vegan snacks and individual packaging.";

export function providerModeLabel(
  workspace: Pick<
    Workspace,
    "marketplace" | "marketplaceLoading" | "marketplaceError"
  >,
) {
  const mode = workspace.marketplace?.mode;
  if (!mode)
    return workspace.marketplaceLoading
      ? "Checking provider mode…"
      : "Provider mode unavailable";
  const label =
    mode === "hybrid"
      ? "Mixed live / demo providers"
      : mode === "demo"
        ? "Demo providers"
        : "Live providers";
  return workspace.marketplaceError ? `Last read: ${label}` : label;
}

export function addSuggestion(draft: string, suggestion: string) {
  return draft.trim() ? `${draft}\n\n${suggestion}` : suggestion;
}

export function clearAcknowledgedDraft(
  active: { scope: DraftScope; text: string },
  submitted: { scope: DraftScope; text: string },
  createdScope: DraftScope | null,
) {
  return (
    (active.scope === submitted.scope || active.scope === createdScope) &&
    active.text === submitted.text
  );
}

export function resolveSelectedNode(
  current: ProductionPlan | null,
  previous: ProductionPlan | null,
  selection: PlanSelection | null,
) {
  if (!selection || !current) return null;
  const source = selection.historical
    ? previous?.planId === selection.planId &&
      previous.orderId === current.orderId
      ? previous
      : null
    : current.planId === selection.planId
      ? current
      : null;
  return source?.nodes.find((node) => node.nodeId === selection.nodeId) ?? null;
}

export function contextIsCompiled(
  asset: AssetRef,
  order: OrderSessionSnapshot | null,
) {
  return Boolean(
    order?.intent?.assets.some(
      (compiled) =>
        compiled.assetId === asset.assetId &&
        compiled.checksum === asset.checksum &&
        (asset.checksum !== undefined || compiled.url === asset.url),
    ),
  );
}

export function decisionActionsBlocked(
  workspace: Pick<
    Workspace,
    | "busy"
    | "loading"
    | "freshness"
    | "pendingAction"
    | "capabilities"
    | "order"
    | "canApprove"
  >,
) {
  return (
    workspace.busy ||
    workspace.loading ||
    workspace.freshness !== "fresh" ||
    isUnresolved(workspace.pendingAction) ||
    workspace.capabilities.requiresOperator ||
    workspace.capabilities.hasUncompiledContexts ||
    (workspace.order?.state === "AWAITING_APPROVAL" && !workspace.canApprove)
  );
}

export function messageOutcome(entry: ConversationEntry) {
  if (entry.status === "sending") return "Sending request";
  switch (entry.outcome?.status) {
    case "succeeded":
      return "Request processed";
    case "failed":
      return "Request could not be completed";
    case "superseded":
      return "Replaced by a later request";
    case "cancelled":
      return "Planning cancelled";
    case "pending":
      return "Request received · result pending";
    default:
      return entry.status === "confirmed"
        ? "Request processed"
        : "Receipt not yet confirmed";
  }
}

export function savedResultTitle(
  order: OrderSessionSnapshot,
  events: MoleculeEvent[],
) {
  const assessment = executionAssessment(order, events);
  if (assessment === "uncertain") return "Commerce outcome needs review";
  if (assessment === "confirmed") return "Commerce records confirmed";
  return stateLabels[order.state];
}

export function historyEmptyMessage(
  workspace: Pick<
    Workspace,
    | "orderId"
    | "order"
    | "historyLoading"
    | "loading"
    | "syncError"
    | "freshness"
  >,
) {
  if (workspace.historyLoading || workspace.loading)
    return "Loading saved requests…";
  if (
    workspace.syncError ||
    workspace.freshness === "stale" ||
    (workspace.orderId && !workspace.order)
  )
    return "Saved requests are currently unavailable. Refresh the project to try again.";
  return workspace.order?.intent
    ? "This project has no retained original messages. Its requirements, plan and confirmed activity are still available."
    : "Send a brief to begin. Your original requests and their confirmed outcomes will be saved here.";
}

type NextStep = {
  title: string;
  detail: string;
  action: "composer" | "execution" | "operations" | "refresh";
  label: string;
};

export function projectNextStep(
  workspace: Pick<
    Workspace,
    | "order"
    | "freshness"
    | "capabilities"
    | "pendingAction"
    | "events"
    | "busy"
    | "operation"
  >,
): NextStep {
  const { order, capabilities, pendingAction, freshness, events } = workspace;
  if (!order)
    return {
      title: "Project unavailable",
      detail: "Read the saved project before making changes.",
      action: "refresh",
      label: "Retry project",
    };
  if (capabilities.requiresOperator)
    return {
      title: "Commerce needs operator review",
      detail:
        "External work may already exist. Keep the receipts and check provider records before taking further action.",
      action: "execution",
      label: "Review recorded actions",
    };
  if (
    pendingAction?.status === "unknown" ||
    pendingAction?.status === "pending"
  )
    return {
      title: workspace.busy
        ? "Request in progress"
        : "Outcome not yet confirmed",
      detail:
        "The original action is retained. A newer plan or a refresh does not prove this action succeeded.",
      action: "refresh",
      label: "Check saved outcome",
    };
  if (freshness === "stale" || freshness === "loading")
    return {
      title: "Checking the latest project",
      detail: "Changes and approval wait for a current, complete project read.",
      action: "refresh",
      label: "Refresh project",
    };
  if (capabilities.hasUncompiledContexts && capabilities.canSubmitMessage)
    return {
      title: "New context needs to enter the brief",
      detail:
        "Attached files are saved, but are not all included in the current requirements. Send an update before reviewing approval.",
      action: "composer",
      label: "Describe how to use the context",
    };
  if (order.state === "AWAITING_APPROVAL")
    return {
      title: "Your plan is ready to review",
      detail:
        "The solver found a feasible plan. Review suppliers, cost and the records approval will create.",
      action: "execution",
      label: "Review plan & actions",
    };
  if (order.state === "NEEDS_CLARIFICATION")
    return {
      title: "A few details are needed",
      detail:
        "Answer the saved questions in the workspace to continue planning.",
      action: "composer",
      label: "Answer the questions",
    };
  if (order.state === "PLAN_UNSAT")
    return {
      title: "The requirements do not fit a feasible plan",
      detail:
        "Review the conflicts and suggested changes before updating the brief.",
      action: "execution",
      label: "Review requirements",
    };
  if (order.state === "COMPLETED") {
    const confirmed = executionAssessment(order, events) === "confirmed";
    return {
      title: confirmed
        ? "Commerce records confirmed"
        : "Commerce outcome needs review",
      detail: confirmed
        ? "Review customer and supplier records. This does not confirm payment, manufacture or delivery."
        : "The saved completion state is missing complete receipt evidence. Review the recorded actions with the operator.",
      action: "execution",
      label: "View commerce records",
    };
  }
  if (order.state === "CANCELLED")
    return {
      title: "Planning cancelled",
      detail:
        "This brief is closed. Saved requests and activity remain available; cancellation does not undo external work.",
      action: "operations",
      label: "View project activity",
    };
  if (processingStates.includes(order.state))
    return {
      title: stateLabels[order.state],
      detail:
        "Molecule is working on the saved request. Activity shows confirmed steps.",
      action: "operations",
      label: "View progress",
    };
  if (order.state === "FAILED" || order.state === "NEEDS_HUMAN")
    return {
      title:
        order.state === "FAILED"
          ? "Planning could not finish"
          : "Planning needs your decision",
      detail: capabilities.canSubmitMessage
        ? "Review the saved result and evidence, then clarify or correct the brief."
        : "Review the recorded outcome before taking further action.",
      action: capabilities.canSubmitMessage ? "composer" : "execution",
      label: capabilities.canSubmitMessage
        ? "Review and update the brief"
        : "Review recorded actions",
    };
  return {
    title: "Ready for a production brief",
    detail:
      "Describe the products, quantity, deadline, budget and requirements.",
    action: "composer",
    label: "Write the brief",
  };
}

export function resumeLabel(project: Pick<ProjectSummary, "state">) {
  if (project.state === "AWAITING_APPROVAL") return "Review plan";
  if (project.state === "COMPLETED") return "View records";
  if (project.state === "CANCELLED") return "View history";
  if (["FAILED", "NEEDS_HUMAN"].includes(project.state))
    return "Review outcome";
  return "Resume project";
}

export function recoveryComparison(
  previous: ProductionPlan | null,
  current: ProductionPlan | null,
  events: MoleculeEvent[],
) {
  const recorded = [...events]
    .reverse()
    .find(
      (event) =>
        event.orderId === current?.orderId &&
        ["recovery.completed", "recovery.approval.required"].includes(
          event.eventType,
        ) &&
        event.payload.replacementPlanId === current?.planId,
    );
  const delta = planDelta(previous, current);
  return {
    cost:
      typeof recorded?.payload.costDelta === "number"
        ? recorded.payload.costDelta
        : delta?.cost,
    hours:
      typeof recorded?.payload.completionDeltaHours === "number"
        ? recorded.payload.completionDeltaHours
        : delta?.hours,
    deadlinePreserved:
      typeof recorded?.payload.deadlinePreserved === "boolean"
        ? recorded.payload.deadlinePreserved
        : null,
  };
}

export function projectTitle(order: OrderSessionSnapshot | null) {
  return (
    order?.intent?.desiredOutputs.map((output) => output.name).join(", ") ||
    "Untitled production project"
  );
}
