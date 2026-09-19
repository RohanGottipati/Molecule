import {
  MoleculeEventSchema,
  type OrderSessionSnapshot,
} from "@molecule/contracts";
import { describe, expect, it } from "vitest";
import { planSelection } from "../lib/decisionPlan";
import { nodeEvidenceContext } from "../lib/decisionPlan";
import {
  capabilities,
  history,
  pending,
  snapshot,
} from "../lib/workspace.fixtures";
import { conversationEntries } from "../lib/synchronization";
import {
  addSuggestion,
  clearAcknowledgedDraft,
  contextIsCompiled,
  decisionActionsBlocked,
  messageOutcome,
  historyEmptyMessage,
  projectNextStep,
  providerModeLabel,
  recoveryComparison,
  resolveSelectedNode,
  savedResultTitle,
} from "./workspacePresentation";

const workspace = {
  order: snapshot,
  freshness: "fresh" as const,
  capabilities: { ...capabilities.capabilities, hasUncompiledContexts: false },
  pendingAction: null,
  events: [],
  busy: false,
  loading: false,
  operation: null,
  canApprove: true,
};
const node = {
  nodeId: "reused-node",
  merchantId: "supplier",
  capabilityId: "supply",
  kind: "SUPPLY" as const,
  quantity: 20,
  unitCost: 40,
  totalCost: 800,
};
const plan = { ...snapshot.activePlan!, nodes: [node] };

describe("scoped composer acknowledgement", () => {
  it("does not clear a newer edit after the submitted request finishes", () => {
    expect(
      clearAcknowledgedDraft(
        { scope: "project:one", text: "New requirements" },
        { scope: "project:one", text: "Original requirements" },
        null,
      ),
    ).toBe(false);
  });
  it("does not clear another project's identical draft", () => {
    expect(
      clearAcknowledgedDraft(
        { scope: "project:two", text: "No polyester" },
        { scope: "project:one", text: "No polyester" },
        null,
      ),
    ).toBe(false);
  });
  it("clears the acknowledged draft only in its original or newly created project", () => {
    const submitted = { scope: "new:one" as const, text: "Create kits" };
    expect(clearAcknowledgedDraft(submitted, submitted, null)).toBe(true);
    expect(
      clearAcknowledgedDraft(
        { ...submitted, scope: "project:created" },
        submitted,
        "project:created",
      ),
    ).toBe(true);
    expect(
      clearAcknowledgedDraft(
        { ...submitted, scope: "new:another" },
        submitted,
        "project:created",
      ),
    ).toBe(false);
  });
  it("adds examples and solver changes after existing draft text without replacing it", () => {
    expect(
      addSuggestion("Keep my deadline.\nNo leather.", "Set budget CAD 7000"),
    ).toBe("Keep my deadline.\nNo leather.\n\nSet budget CAD 7000");
    expect(addSuggestion("  ", "Make kits")).toBe("Make kits");
  });
});

describe("durable request outcomes", () => {
  it("does not infer absent history or commerce success from incomplete reads", () => {
    const current = {
      ...workspace,
      orderId: snapshot.orderId,
      historyLoading: false,
      syncError: null,
    };
    expect(historyEmptyMessage(current)).toContain(
      "no retained original messages",
    );
    expect(historyEmptyMessage({ ...current, freshness: "stale" })).toContain(
      "currently unavailable",
    );
    expect(historyEmptyMessage({ ...current, order: null })).toContain(
      "currently unavailable",
    );
    expect(
      historyEmptyMessage({ ...current, syncError: "History read failed" }),
    ).toContain("currently unavailable");
    expect(historyEmptyMessage({ ...current, historyLoading: true })).toBe(
      "Loading saved requests…",
    );
    expect(savedResultTitle({ ...snapshot, state: "COMPLETED" }, [])).toBe(
      "Commerce outcome needs review",
    );
  });
  it.each([
    ["pending", "Request received · result pending"],
    ["succeeded", "Request processed"],
    ["failed", "Request could not be completed"],
    ["superseded", "Replaced by a later request"],
    ["cancelled", "Planning cancelled"],
  ] as const)(
    "presents authoritative %s outcomes despite the local unconfirmed label",
    (status, expected) => {
      const entry = history.messages[0]!;
      const rows = conversationEntries(
        [{ ...entry, outcome: { ...entry.outcome, status } }],
        pending,
      );
      expect(rows).toHaveLength(1);
      expect(messageOutcome(rows[0]!)).toBe(expected);
    },
  );
  it("never describes an unknown retained request as a completed result", () => {
    const row = conversationEntries([], pending)[0]!;
    expect(messageOutcome(row)).toBe("Receipt not yet confirmed");
    expect(messageOutcome({ ...row, status: "sending" })).toBe(
      "Sending request",
    );
  });
});

describe("project next action", () => {
  it.each([
    ["NEEDS_CLARIFICATION", "composer"],
    ["AWAITING_APPROVAL", "execution"],
    ["PLAN_UNSAT", "execution"],
    ["CANCELLED", "operations"],
    ["QUOTING", "operations"],
    ["FAILED", "composer"],
  ] as const)("gives %s a relevant destination", (state, action) => {
    expect(
      projectNextStep({ ...workspace, order: { ...snapshot, state } }).action,
    ).toBe(action);
  });
  it("prioritizes retained unknown operations over a newly valid plan", () => {
    const next = projectNextStep({ ...workspace, pendingAction: pending });
    expect(next.title).toBe("Outcome not yet confirmed");
    expect(next.action).toBe("refresh");
  });
  it("prioritizes operator reconciliation over correction and approval", () => {
    const next = projectNextStep({
      ...workspace,
      capabilities: { ...workspace.capabilities, requiresOperator: true },
      pendingAction: pending,
    });
    expect(next.action).toBe("execution");
    expect(next.title).toBe("Commerce needs operator review");
  });
  it("directs newly attached context into compilation before approval", () => {
    const next = projectNextStep({
      ...workspace,
      capabilities: { ...workspace.capabilities, hasUncompiledContexts: true },
    });
    expect(next.action).toBe("composer");
    expect(next.title).toBe("New context needs to enter the brief");
  });
  it("does not claim commerce success solely from completed state", () => {
    expect(
      projectNextStep({
        ...workspace,
        order: { ...snapshot, state: "COMPLETED", executionReceipt: null },
      }).title,
    ).toBe("Commerce outcome needs review");
  });
  it("offers an explicit retry for unavailable or stale project data", () => {
    expect(projectNextStep({ ...workspace, order: null }).action).toBe(
      "refresh",
    );
    expect(projectNextStep({ ...workspace, freshness: "stale" }).action).toBe(
      "refresh",
    );
    expect(
      projectNextStep({ ...workspace, freshness: "refreshing" }).title,
    ).toBe("Your plan is ready to review");
  });
});

describe("plan and attachment boundaries", () => {
  it("does not ask to compile context in a closed project", () => {
    expect(
      projectNextStep({
        ...workspace,
        order: { ...snapshot, state: "CANCELLED" },
        capabilities: {
          ...workspace.capabilities,
          canSubmitMessage: false,
          hasUncompiledContexts: true,
        },
      }).action,
    ).toBe("operations");
  });
  it("re-resolves current nodes but closes selections after replacement or disappearance", () => {
    const selection = planSelection(plan, node.nodeId, plan.planId);
    expect(
      resolveSelectedNode(
        { ...plan, nodes: [{ ...node, totalCost: 900 }] },
        null,
        selection,
      )?.totalCost,
    ).toBe(900);
    expect(
      resolveSelectedNode({ ...plan, planId: "replacement" }, plan, selection),
    ).toBeNull();
    expect(
      resolveSelectedNode({ ...plan, nodes: [] }, null, selection),
    ).toBeNull();
  });
  it("keeps historical node prices and currencies separate despite reused node IDs", () => {
    const previous = {
      ...plan,
      planId: "old",
      currency: "USD" as const,
      nodes: [{ ...node, totalCost: 40 }],
    };
    const selection = planSelection(previous, node.nodeId, plan.planId);
    const selected = resolveSelectedNode(plan, previous, selection)!;
    expect(selected.totalCost).toBe(40);
    expect(nodeEvidenceContext(plan, selected, selection)).toMatchObject({
      current: false,
      currency: "USD",
    });
    expect(
      resolveSelectedNode(plan, { ...previous, orderId: "another" }, selection),
    ).toBeNull();
  });
  it("requires matching attachment contents rather than matching asset name alone", () => {
    const asset = { assetId: "logo", name: "Logo", checksum: "v2" };
    const compiled: OrderSessionSnapshot = {
      ...snapshot,
      intent: { ...snapshot.intent!, assets: [asset] },
    };
    expect(contextIsCompiled(asset, compiled)).toBe(true);
    expect(contextIsCompiled({ ...asset, checksum: "v3" }, compiled)).toBe(
      false,
    );
    expect(contextIsCompiled(asset, snapshot)).toBe(false);
    const linked = { assetId: "logo", url: "https://example.test/logo" };
    expect(
      contextIsCompiled(linked, {
        ...compiled,
        intent: { ...compiled.intent!, assets: [linked] },
      }),
    ).toBe(true);
    expect(
      contextIsCompiled(
        { ...linked, url: "https://example.test/different" },
        { ...compiled, intent: { ...compiled.intent!, assets: [linked] } },
      ),
    ).toBe(false);
  });
  it("disables decision controls during stale reads, unknown actions or unused context", () => {
    expect(decisionActionsBlocked(workspace)).toBe(false);
    expect(
      decisionActionsBlocked({ ...workspace, freshness: "refreshing" }),
    ).toBe(true);
    expect(
      decisionActionsBlocked({ ...workspace, pendingAction: pending }),
    ).toBe(true);
    expect(decisionActionsBlocked({ ...workspace, canApprove: false })).toBe(
      true,
    );
    expect(
      decisionActionsBlocked({
        ...workspace,
        capabilities: {
          ...workspace.capabilities,
          hasUncompiledContexts: true,
        },
      }),
    ).toBe(true);
    expect(
      decisionActionsBlocked({
        ...workspace,
        capabilities: { ...workspace.capabilities, requiresOperator: true },
      }),
    ).toBe(true);
  });
  it("keeps eligible completed-project demo recovery available without enabling approval", () => {
    expect(
      decisionActionsBlocked({
        ...workspace,
        order: { ...snapshot, state: "COMPLETED" },
        canApprove: false,
      }),
    ).toBe(false);
  });
  it("uses persisted recovery completion changes after reload and ignores other projects", () => {
    const event = MoleculeEventSchema.parse({
      eventId: "aabbccdd-1234-4234-9234-123456789abc",
      traceId: snapshot.traceId,
      orderId: snapshot.orderId,
      eventType: "recovery.completed",
      source: "orchestrator",
      severity: "INFO",
      ts: snapshot.updatedAt,
      payload: {
        replacementPlanId: plan.planId,
        costDelta: 50,
        completionDeltaHours: 4,
        deadlinePreserved: false,
      },
    });
    expect(recoveryComparison(null, plan, [event])).toEqual({
      cost: 50,
      hours: 4,
      deadlinePreserved: false,
    });
    expect(
      recoveryComparison(null, plan, [{ ...event, orderId: "other" }]),
    ).toEqual({ cost: undefined, hours: undefined, deadlinePreserved: null });
  });
});

describe("provider mode provenance", () => {
  it("does not infer live providers from absent marketplace data", () => {
    expect(
      providerModeLabel({
        marketplace: null,
        marketplaceLoading: false,
        marketplaceError: "unavailable",
      }),
    ).toBe("Provider mode unavailable");
    expect(
      providerModeLabel({
        marketplace: null,
        marketplaceLoading: true,
        marketplaceError: null,
      }),
    ).toBe("Checking provider mode…");
  });
});
