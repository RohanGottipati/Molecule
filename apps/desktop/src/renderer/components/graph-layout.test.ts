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

it("keeps a multi-branch DAG stable without changing backend nodes or edges", () => {
  const ids = [
    "hoodie",
    "bottle",
    "snacks",
    "embroider",
    "engrave",
    "assemble",
    "fulfill",
  ];
  const dependencies = [
    ["hoodie", "embroider"],
    ["bottle", "engrave"],
    ["embroider", "assemble"],
    ["engrave", "assemble"],
    ["snacks", "assemble"],
    ["assemble", "fulfill"],
  ];
  const plan = ProductionPlanSchema.parse({
    planId: "kit",
    orderId: "project",
    intentVersion: 1,
    status: "VALID",
    nodes: ids.map((id) => ({
      nodeId: id,
      merchantId: id,
      capabilityId: id,
      kind: "SUPPLY",
      quantity: 200,
      unitCost: 2,
      totalCost: 400,
    })),
    edges: dependencies.map(([fromNodeId, toNodeId], index) => ({
      edgeId: String(index),
      fromNodeId,
      toNodeId,
      material: "kit",
      quantity: 200,
      unit: "unit",
    })),
    totalCost: 2800,
    currency: "CAD",
    riskScore: 0,
    constraintResults: [],
    unsatRelaxations: [],
  });
  const before = JSON.stringify(plan);
  const expected = [
    ["hoodie", "bottle", "snacks"],
    ["embroider", "engrave"],
    ["assemble"],
    ["fulfill"],
  ];
  expect(
    planLayers(plan).map((layer) => layer.map((node) => node.nodeId)),
  ).toEqual(expected);
  expect(
    planLayers(plan).map((layer) => layer.map((node) => node.nodeId)),
  ).toEqual(expected);
  expect(JSON.stringify(plan)).toBe(before);
  const position = new Map(
    planLayers(plan).flatMap((layer, index) =>
      layer.map((node) => [node.nodeId, index] as const),
    ),
  );
  for (const edge of plan.edges)
    expect(position.get(edge.fromNodeId)).toBeLessThan(
      position.get(edge.toNodeId)!,
    );
});

it("terminates safely for invalid cyclic graphs without hiding nodes", () => {
  const plan = ProductionPlanSchema.parse({
    planId: "cycle",
    orderId: "project",
    intentVersion: 1,
    status: "UNSAT",
    nodes: ["a", "b"].map((id) => ({
      nodeId: id,
      merchantId: id,
      capabilityId: id,
      kind: "SUPPLY",
      quantity: 1,
      unitCost: 1,
      totalCost: 1,
    })),
    edges: [
      ["a", "b"],
      ["b", "a"],
    ].map(([fromNodeId, toNodeId], index) => ({
      edgeId: String(index),
      fromNodeId,
      toNodeId,
      material: "kit",
      quantity: 1,
      unit: "unit",
    })),
    totalCost: 2,
    currency: "CAD",
    riskScore: 0,
    constraintResults: [],
    unsatRelaxations: [],
  });
  expect(
    planLayers(plan)
      .flat()
      .map((node) => node.nodeId),
  ).toEqual(["a", "b"]);
  expect(plan.status).toBe("UNSAT");
});
