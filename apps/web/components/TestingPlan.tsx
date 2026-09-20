"use client";

import { useState } from "react";
import {
  CandidateCapabilitySchema,
  MerchantTwinSummarySchema,
  ProductionPlanSchema,
  type ProductionPlan,
} from "@molecule/contracts";
import { GraphDetailPanel } from "./GraphDetailPanel";
import { PlanGraph, resolveNode } from "./PlanGraph";
import { money } from "../lib/workspace";

// Presentation-only fixtures. Never submitted to the solver or execution APIs.
const steps = [
  {
    id: "fibre",
    name: "Aegean Fibre Co.",
    label: "Organic cotton jersey",
    kind: "SUPPLY",
    quantity: 1200,
    unit: "m",
    cost: 5040,
  },
  {
    id: "dye",
    name: "Noor Pigments",
    label: "Low-impact reactive dye",
    kind: "SUPPLY",
    quantity: 90,
    unit: "kg",
    cost: 1035,
  },
  {
    id: "knit",
    name: "Verde Knitworks",
    label: "Circular knit & finish",
    kind: "TRANSFORM",
    quantity: 1200,
    unit: "m",
    cost: 3360,
  },
  {
    id: "trims",
    name: "Kestrel Trims",
    label: "Woven label & care tag",
    kind: "TRANSFORM",
    quantity: 2400,
    unit: "pcs",
    cost: 432,
  },
  {
    id: "assemble",
    name: "Atelier Ninety",
    label: "Cut, sew & QC",
    kind: "ASSEMBLE",
    quantity: 2400,
    unit: "units",
    cost: 15360,
  },
  {
    id: "ship",
    name: "Northline 3PL",
    label: "Pick, pack & ship",
    kind: "FULFILL",
    quantity: 2400,
    unit: "units",
    cost: 2760,
  },
] as const;

const candidates = steps.map((step) =>
  CandidateCapabilitySchema.parse({
    capabilityId: step.id,
    merchantId: step.id,
    score: 1,
    capability: {
      capabilityId: step.id,
      merchantId: step.id,
      kind: step.kind,
      name: step.label,
      description: "Synthetic UI sample",
      accepts: [],
      produces: [],
      quantity: { min: 1, max: 10000, unit: step.unit },
      pricing: { currency: "CAD", unitPrice: step.cost / step.quantity },
      leadTime: { min: 1, max: 3, unit: "days" },
      capacity: {},
      hardRules: [],
      softRules: [],
      sourceClaimIds: [],
    },
  }),
);
const merchants = steps.map((step) =>
  MerchantTwinSummarySchema.parse({
    merchantId: step.id,
    name: step.name,
    status: "online",
    capabilities: candidates.filter((item) => item.merchantId === step.id),
    claims: [],
    memories: [],
    policies: [],
    documents: [],
  }),
);
const samplePlan = ProductionPlanSchema.parse({
  planId: "ui-sample-plan",
  orderId: "ui-sample-only",
  intentVersion: 1,
  status: "VALID",
  currency: "CAD",
  riskScore: 0,
  constraintResults: [],
  totalCost: steps.reduce((sum, step) => sum + step.cost, 0),
  nodes: steps.map((step) => ({
    nodeId: step.id,
    merchantId: step.id,
    capabilityId: step.id,
    kind: step.kind,
    quantity: step.quantity,
    unitCost: step.cost / step.quantity,
    totalCost: step.cost,
  })),
  edges: [
    {
      edgeId: "fibre-knit",
      fromNodeId: "fibre",
      toNodeId: "knit",
      material: "cotton jersey",
      quantity: 1200,
      unit: "m",
    },
    {
      edgeId: "dye-knit",
      fromNodeId: "dye",
      toNodeId: "knit",
      material: "dye",
      quantity: 90,
      unit: "kg",
    },
    {
      edgeId: "knit-assemble",
      fromNodeId: "knit",
      toNodeId: "assemble",
      material: "finished fabric",
      quantity: 1200,
      unit: "m",
    },
    {
      edgeId: "trims-assemble",
      fromNodeId: "trims",
      toNodeId: "assemble",
      material: "labels",
      quantity: 2400,
      unit: "pcs",
    },
    {
      edgeId: "assemble-ship",
      fromNodeId: "assemble",
      toNodeId: "ship",
      material: "garments",
      quantity: 2400,
      unit: "units",
    },
  ],
});
const offlineMerchants = new Set(["trims"]);

export function TestingPlan() {
  const [selected, setSelected] = useState<
    ProductionPlan["nodes"][number] | null
  >(null);
  const resolved = selected
    ? resolveNode(selected, merchants, candidates, offlineMerchants)
    : null;
  return (
    <section
      className="plan-actions-dark canvas-plan"
      aria-label="Sample production flow chart"
    >
      <div className="canvas-heading">
        <div>
          <p className="eyebrow">SAMPLE DATA · UI PREVIEW</p>
          <h1>Testing</h1>
          <p className="muted small">
            Sample flow · Shared with production plans.
          </p>
        </div>
      </div>
      <PlanGraph
        plan={samplePlan}
        previousPlan={null}
        merchants={merchants}
        candidates={candidates}
        offlineMerchants={offlineMerchants}
        onSelect={setSelected}
        overlay={
          selected && resolved ? (
            <GraphDetailPanel onClose={() => setSelected(null)}>
              <>
                <h2 id="sample-node-title">{resolved.merchantName}</h2>
                <p className="muted">{resolved.label}</p>
                <dl className="detail-grid">
                  <div>
                    <dt>Step</dt>
                    <dd>{selected.kind}</dd>
                  </div>
                  <div>
                    <dt>Availability</dt>
                    <dd>
                      {resolved.offline ? "Offline" : "Selected supplier"}
                    </dd>
                  </div>
                  <div>
                    <dt>Quantity</dt>
                    <dd>
                      {selected.quantity.toLocaleString("en-GB")}{" "}
                      {resolved.unit}
                    </dd>
                  </div>
                  <div>
                    <dt>Total cost</dt>
                    <dd>{money(selected.totalCost, samplePlan.currency)}</dd>
                  </div>
                  <div>
                    <dt>Unit cost</dt>
                    <dd>{money(selected.unitCost, samplePlan.currency)}</dd>
                  </div>
                  <div>
                    <dt>Completion</dt>
                    <dd>Not provided in sample</dd>
                  </div>
                </dl>
                <details className="graph-detail-connections">
                  <summary>Connected steps</summary>
                  <ul className="sample-node-connections">
                    {samplePlan.edges
                      .filter(
                        (edge) =>
                          edge.fromNodeId === selected.nodeId ||
                          edge.toNodeId === selected.nodeId,
                      )
                      .map((edge) => {
                        const incoming = edge.toNodeId === selected.nodeId;
                        const other = steps.find(
                          (step) =>
                            step.id ===
                            (incoming ? edge.fromNodeId : edge.toNodeId),
                        );
                        return (
                          <li key={edge.edgeId}>
                            <strong>
                              {incoming ? "From" : "To"} {other?.name}
                            </strong>
                            <span>
                              {edge.material} ·{" "}
                              {edge.quantity.toLocaleString("en-GB")}{" "}
                              {edge.unit}
                            </span>
                          </li>
                        );
                      })}
                  </ul>
                </details>
                <p className="muted small">
                  Production step details include the project’s quotes and
                  evidence.
                </p>
              </>
            </GraphDetailPanel>
          ) : null
        }
      />
    </section>
  );
}
