import { ProductionPlanSchema } from "@molecule/contracts";
import { expect, it } from "vitest";
import { planLayers } from "./graph-layout.js";

it("renders parallel supplier branches before their common downstream node", () => {
  const plan = ProductionPlanSchema.parse({
    planId: "graph",
    orderId: "project",
    intentVersion: 1,
    status: "VALID",
    nodes: ["hoodie", "bottle", "pack"].map((id) => ({
      nodeId: id,
      merchantId: id,
      capabilityId: id,
      kind: "SUPPLY",
      quantity: 1,
      unitCost: 2,
      totalCost: 2,
    })),
    edges: ["hoodie", "bottle"].map((id) => ({
      edgeId: id,
      fromNodeId: id,
      toNodeId: "pack",
      material: "kit",
      quantity: 1,
      unit: "unit",
    })),
    totalCost: 6,
    currency: "CAD",
    riskScore: 0,
    constraintResults: [],
    unsatRelaxations: [],
  });
  expect(
    planLayers(plan).map((layer) => layer.map((node) => node.nodeId)),
  ).toEqual([["hoodie", "bottle"], ["pack"]]);
});
