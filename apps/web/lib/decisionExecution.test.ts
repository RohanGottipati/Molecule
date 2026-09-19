import {
  ExecutionReceiptSchema,
  MoleculeEventSchema,
  OrderSessionSnapshotSchema,
  ProductionPlanSchema,
} from "@molecule/contracts";
import { describe, expect, it } from "vitest";
import { canApproveDecision, executionAssessment } from "./decisionExecution";
import { nodeEvidenceContext, planSelection } from "./decisionPlan";

const plan = ProductionPlanSchema.parse({
  planId: "plan-current",
  orderId: "project",
  intentVersion: 2,
  status: "VALID",
  totalCost: 200,
  currency: "CAD",
  riskScore: 0,
  constraintResults: [],
  nodes: [
    {
      nodeId: "node",
      merchantId: "supplier",
      capabilityId: "capability",
      kind: "SUPPLY",
      quantity: 10,
      unitCost: 20,
      totalCost: 200,
    },
  ],
  edges: [],
});
const order = OrderSessionSnapshotSchema.parse({
  orderId: "project",
  traceId: "trace",
  state: "AWAITING_APPROVAL",
  revision: 1,
  intentVersion: 2,
  planGeneration: 1,
  eventCursor: 1,
  intent: null,
  candidates: [],
  quotes: [],
  activePlan: plan,
  executionReceipt: null,
  lastErrorCode: null,
  createdAt: "2026-09-19T10:00:00Z",
  updatedAt: "2026-09-19T10:00:00Z",
});

describe("commerce decisions", () => {
  it("only permits a current solver plan awaiting approval", () => {
    expect(canApproveDecision(order)).toBe(true);
    expect(canApproveDecision({ ...order, intentVersion: 3 })).toBe(false);
    expect(
      canApproveDecision({
        ...order,
        activePlan: { ...plan, orderId: "other" },
      }),
    ).toBe(false);
    expect(canApproveDecision({ ...order, state: "NEEDS_HUMAN" })).toBe(false);
    expect(executionAssessment(order)).toBe("awaiting");
    expect(executionAssessment({ ...order, state: "EXECUTING" })).toBe(
      "executing",
    );
  });
  it("distinguishes infeasible planning from unknown or partial external execution", () => {
    const needsHuman = { ...order, state: "NEEDS_HUMAN" as const };
    expect(executionAssessment(needsHuman)).toBe("uncertain");
    expect(
      executionAssessment({
        ...needsHuman,
        activePlan: { ...plan, status: "UNSAT" },
      }),
    ).toBe("planning");
    expect(
      executionAssessment({
        ...needsHuman,
        activePlan: { ...plan, status: "UNSAT" },
        executionReceipt: {
          orderId: order.orderId,
          planId: "previous",
          intentVersion: 1,
          supplierJobs: [],
          actions: [
            {
              actionKey: "unknown-write",
              kind: "CUSTOMER_ORDER",
              status: "PENDING",
            },
          ],
        },
      }),
    ).toBe("uncertain");
  });
  it("does not treat old or foreign failure events as a current execution failure", () => {
    const event = MoleculeEventSchema.parse({
      eventId: "aabbccdd-1234-4234-9234-123456789abc",
      traceId: "trace",
      orderId: order.orderId,
      planId: "old",
      eventType: "execution.failed",
      severity: "ERROR",
      source: "shopify",
      ts: "2026-09-19T10:00:00Z",
      payload: {},
    });
    const planning = {
      ...order,
      state: "NEEDS_HUMAN" as const,
      activePlan: { ...plan, status: "UNSAT" as const },
    };
    expect(executionAssessment(planning, [event])).toBe("planning");
    expect(
      executionAssessment(planning, [{ ...event, planId: plan.planId }]),
    ).toBe("uncertain");
    expect(
      executionAssessment(planning, [
        { ...event, planId: plan.planId, orderId: "other" },
      ]),
    ).toBe("planning");
  });
  it("requires matching complete receipts before displaying confirmed execution", () => {
    const receipt = ExecutionReceiptSchema.parse({
      orderId: order.orderId,
      planId: plan.planId,
      intentVersion: plan.intentVersion,
      compositeProduct: {
        productGid: "product",
        variantGid: "variant",
        storeDomain: "composite.myshopify.com",
      },
      customerOrder: { draftOrderGid: "customer" },
      supplierJobs: [
        {
          merchantId: "supplier",
          nodeId: "node",
          storeDomain: "supplier.myshopify.com",
          draftOrderGid: "draft",
        },
      ],
      actions: [
        { actionKey: "job", kind: "SUPPLIER_JOB", status: "SUCCEEDED" },
      ],
    });
    const completed = {
      ...order,
      state: "COMPLETED" as const,
      executionReceipt: receipt,
    };
    expect(executionAssessment(completed)).toBe("confirmed");
    expect(executionAssessment({ ...completed, executionReceipt: null })).toBe(
      "uncertain",
    );
    for (const partial of [
      { ...receipt, planId: "previous" },
      { ...receipt, orderId: "other" },
      { ...receipt, intentVersion: 1 },
      { ...receipt, actions: [] },
      { ...receipt, supplierJobs: [] },
      { ...receipt, customerOrder: undefined },
      {
        ...receipt,
        actions: [{ ...receipt.actions[0]!, status: "PENDING" as const }],
      },
    ])
      expect(
        executionAssessment({ ...completed, executionReceipt: partial }),
      ).toBe("uncertain");
  });
});

describe("plan-aware evidence", () => {
  it("keeps previous currency and excludes current evidence when node IDs are reused", () => {
    const old = { ...plan, planId: "previous", currency: "USD" as const };
    const selection = planSelection(old, "node", plan.planId);
    expect(selection).toEqual({
      planId: "previous",
      nodeId: "node",
      currency: "USD",
      historical: true,
    });
    expect(nodeEvidenceContext(plan, old.nodes[0]!, selection)).toMatchObject({
      current: false,
      currency: "USD",
    });
  });
  it("resolves current nodes from the snapshot and closes the evidence boundary after replanning", () => {
    const node = plan.nodes[0]!;
    const selection = planSelection(plan, node.nodeId, plan.planId);
    const updated = { ...plan, nodes: [{ ...node, totalCost: 300 }] };
    expect(nodeEvidenceContext(updated, node, selection).node.totalCost).toBe(
      300,
    );
    expect(
      nodeEvidenceContext(
        { ...updated, planId: "replacement" },
        node,
        selection,
      ).current,
    ).toBe(false);
    expect(nodeEvidenceContext(plan, { ...node }).current).toBe(false);
  });
});
