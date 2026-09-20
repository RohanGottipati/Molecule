import {
  MoleculeEventSchema,
  OrderSessionSnapshotSchema,
  ProductionPlanSchema,
} from "@molecule/contracts";
import { describe, expect, it } from "vitest";
import {
  canEditBrief,
  graphPositions,
  mergeContexts,
  mergeEvents,
  mergeSnapshot,
  money,
  parseEvent,
  parseView,
  planDelta,
  safeHref,
  supplierAdminUrl,
} from "./workspace";

const snapshot = OrderSessionSnapshotSchema.parse({
  orderId: "project-one",
  traceId: "trace-one",
  state: "REQUESTED",
  revision: 8,
  intentVersion: 2,
  planGeneration: 3,
  eventCursor: 12,
  intent: null,
  candidates: [],
  quotes: [],
  activePlan: null,
  executionReceipt: null,
  lastErrorCode: null,
  createdAt: "2026-09-19T10:00:00Z",
  updatedAt: "2026-09-19T10:00:00Z",
});

it("keeps brief changes out of in-flight and completed commerce", () => {
  expect(canEditBrief(null)).toBe(true);
  for (const state of [
    "AWAITING_APPROVAL",
    "NEEDS_CLARIFICATION",
    "FAILED",
  ] as const)
    expect(canEditBrief({ ...snapshot, state })).toBe(true);
  for (const state of [
    "QUOTING",
    "EXECUTING",
    "COMPLETED",
    "CANCELLED",
    "RECOVERING",
  ] as const)
    expect(canEditBrief({ ...snapshot, state })).toBe(false);
});
const event = MoleculeEventSchema.parse({
  eventId: "aabbccdd-1234-4234-9234-123456789abc",
  traceId: "trace-one",
  orderId: "project-one",
  eventType: "solver.valid",
  ts: "2026-09-19T10:00:00Z",
  severity: "INFO",
  source: "solver",
  payload: {},
});
const plan = ProductionPlanSchema.parse({
  planId: "plan-one",
  orderId: "project-one",
  intentVersion: 2,
  status: "VALID",
  totalCost: 6800,
  currency: "CAD",
  riskScore: 0.1,
  estimatedCompletion: "2026-09-25T12:00:00Z",
  constraintResults: [],
  nodes: [
    "hoodie",
    "bottle",
    "snack",
    "embroidery",
    "engraving",
    "assembly",
    "fulfill",
  ].map((nodeId) => ({
    nodeId,
    merchantId: nodeId,
    capabilityId: nodeId,
    kind: nodeId === "assembly" ? "ASSEMBLE" : "SUPPLY",
    quantity: 200,
    unitCost: 4,
    totalCost: 800,
  })),
  edges: [
    ["hoodie", "embroidery"],
    ["bottle", "engraving"],
    ["embroidery", "assembly"],
    ["engraving", "assembly"],
    ["snack", "assembly"],
    ["assembly", "fulfill"],
  ].map(([fromNodeId, toNodeId], index) => ({
    edgeId: `edge-${index}`,
    fromNodeId,
    toNodeId,
    material: "goods",
    quantity: 200,
    unit: "units",
  })),
});

describe("project state boundaries", () => {
  it("does not lose confirmed attachments to an older context response", () => {
    const logo = { assetId: "logo", checksum: "verified", name: "logo.png" };
    expect(mergeContexts([logo], [])).toEqual([logo]);
    expect(mergeContexts([logo], [logo])).toEqual([logo]);
  });
  it("never guesses a currency for a partially compiled brief", () => {
    expect(money(7000)).toBe("7,000 (currency unknown)");
    expect(money(null, "CAD")).toBe("Not provided");
  });
  it.each([
    "revision",
    "intentVersion",
    "planGeneration",
    "eventCursor",
  ] as const)(
    "rejects a stale %s even if another counter is newer",
    (counter) => {
      const incoming = {
        ...snapshot,
        revision: 9,
        [counter]: snapshot[counter] - 1,
      };
      expect(mergeSnapshot(snapshot, incoming, snapshot.orderId)).toBe(
        snapshot,
      );
    },
  );
  it("rejects responses from a project left while a request was running", () => {
    expect(
      mergeSnapshot(
        snapshot,
        { ...snapshot, orderId: "old-project", revision: 100 },
        snapshot.orderId,
      ),
    ).toBe(snapshot);
  });
  it("accepts current snapshots and initializes a deep-linked project", () => {
    const next = { ...snapshot, revision: 9, eventCursor: 13 };
    expect(mergeSnapshot(snapshot, next, snapshot.orderId)).toBe(next);
    expect(mergeSnapshot(null, snapshot, snapshot.orderId)).toBe(snapshot);
  });
  it("validates SSE before use and rejects malformed or foreign events", () => {
    expect(parseEvent(JSON.stringify(event), snapshot.orderId)?.eventId).toBe(
      event.eventId,
    );
    expect(parseEvent("not-json", snapshot.orderId)).toBeNull();
    expect(
      parseEvent(
        JSON.stringify({ ...event, eventId: "invalid" }),
        snapshot.orderId,
      ),
    ).toBeNull();
    expect(parseEvent(JSON.stringify(event), "different-project")).toBeNull();
    expect(
      parseEvent(
        JSON.stringify({ ...event, source: "invented" }),
        snapshot.orderId,
      ),
    ).toBeNull();
  });
  it("deduplicates replayed events, preserves the first payload and orders history", () => {
    const earlier = {
      ...event,
      eventId: "aabbccdd-1234-4234-9234-123456789abd",
      ts: "2026-09-19T09:00:00Z",
    };
    const merged = mergeEvents(
      [event],
      [earlier, { ...event, payload: { forged: true } }, earlier],
    );
    expect(merged).toEqual([earlier, event]);
    expect(mergeEvents(merged, [], 1)).toEqual([event]);
  });
  it("accepts only supported workspace URL values", () => {
    expect(parseView("execution")).toBe("execution");
    expect(parseView("unknown")).toBe("command");
    expect(parseView(null)).toBe("command");
  });
});

describe("production graph", () => {
  it("lays out branches by dependency depth rather than array order", () => {
    const positions = graphPositions({
      ...plan,
      nodes: [...plan.nodes].reverse(),
    });
    for (const edge of plan.edges)
      expect(positions.get(edge.fromNodeId)!.x).toBeLessThan(
        positions.get(edge.toNodeId)!.x,
      );
    expect(positions.get("hoodie")!.x).toBe(positions.get("bottle")!.x);
    expect(positions.get("hoodie")!.y).not.toBe(positions.get("bottle")!.y);
    expect(
      new Set([...positions.values()].map(({ x, y }) => `${x}:${y}`)).size,
    ).toBe(plan.nodes.length);
  });
  it("terminates safely on cyclic input without certifying feasibility", () => {
    const cyclic = {
      ...plan,
      edges: [
        ...plan.edges,
        {
          edgeId: "cycle",
          fromNodeId: "fulfill",
          toNodeId: "hoodie",
          material: "cycle",
          quantity: 1,
          unit: "units",
        },
      ],
    };
    expect(graphPositions(cyclic).size).toBe(plan.nodes.length);
    expect(graphPositions({ ...plan, nodes: [], edges: [] }).size).toBe(0);
  });
  it("computes deltas only for a different valid plan in the same currency", () => {
    const replacement = {
      ...plan,
      planId: "replacement",
      totalCost: 6900,
      estimatedCompletion: "2026-09-25T14:00:00Z",
    };
    expect(planDelta(plan, replacement)).toEqual({ cost: 100, hours: 2 });
    expect(planDelta(plan, plan)).toBeNull();
    expect(planDelta(plan, { ...replacement, status: "UNSAT" })).toBeNull();
    expect(planDelta(plan, { ...replacement, currency: "USD" })).toBeNull();
    expect(planDelta(null, replacement)).toBeNull();
  });
});

describe("provider links", () => {
  it("rejects script, credential-bearing and relative URLs", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,test",
      "https://user:secret@example.com",
      "/admin",
      "file:///etc/passwd",
    ])
      expect(safeHref(href)).toBeUndefined();
    expect(safeHref("https://shop.myshopify.com/admin/products/1")).toBe(
      "https://shop.myshopify.com/admin/products/1",
    );
  });
  it("constructs supplier admin links only from Shopify domains and DraftOrder GIDs", () => {
    expect(
      supplierAdminUrl(
        "supplier.myshopify.com",
        "gid://shopify/DraftOrder/123",
      ),
    ).toBe("https://supplier.myshopify.com/admin/draft_orders/123");
    expect(
      supplierAdminUrl(
        "supplier.myshopify.com.evil.example",
        "gid://shopify/DraftOrder/123",
      ),
    ).toBeUndefined();
    expect(
      supplierAdminUrl("supplier.myshopify.com", "gid://shopify/Product/123"),
    ).toBeUndefined();
    expect(
      supplierAdminUrl(
        "supplier.myshopify.com",
        "gid://shopify/DraftOrder/123/../../",
      ),
    ).toBeUndefined();
  });
});
