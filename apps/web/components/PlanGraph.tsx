"use client";

import type {
  CandidateCapability,
  MerchantTwinSummary,
  ProductionPlan,
} from "@molecule/contracts";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useMemo } from "react";
import { planSelection, type PlanSelection } from "../lib/decisionPlan";
import { dateLabel, graphPositions, humanize, money } from "../lib/workspace";

type PlanNodeData = {
  label: string;
  merchant: string;
  cost: string;
  deadline: string;
  quantity: number;
  status: string;
  unavailable: boolean;
  onSelect: () => void;
};

function ProductionNode({ data }: NodeProps<Node<PlanNodeData>>) {
  return (
    <button
      className={`production-node nodrag ${data.unavailable ? "node-failed" : ""}`}
      onClick={data.onSelect}
      type="button"
    >
      <Handle type="target" position={Position.Left} />
      <span className="node-kicker">
        {data.label}
        <span>{data.status}</span>
      </span>
      <strong>{data.merchant}</strong>
      <span className="node-price">
        {data.cost}
        <small>{data.quantity} units</small>
      </span>
      <span className="node-date">
        Due {data.deadline}
        <span aria-hidden="true">↗</span>
      </span>
      <Handle type="source" position={Position.Right} />
    </button>
  );
}

const nodeTypes = { production: ProductionNode };

export function PlanGraph({
  plan,
  previousPlan,
  merchants,
  candidates,
  offlineMerchants,
  onSelect,
  onSelectContext,
}: {
  plan: ProductionPlan;
  previousPlan: ProductionPlan | null;
  merchants: MerchantTwinSummary[];
  candidates: CandidateCapability[];
  offlineMerchants: Set<string>;
  onSelect: (node: ProductionPlan["nodes"][number]) => void;
  onSelectContext?: (selection: PlanSelection) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const positions = graphPositions(plan);
    const historical =
      previousPlan?.planId !== plan.planId
        ? (previousPlan?.nodes.filter(
            (node) =>
              offlineMerchants.has(node.merchantId) &&
              !plan.nodes.some(
                (active) =>
                  active.merchantId === node.merchantId &&
                  active.capabilityId === node.capabilityId,
              ),
          ) ?? [])
        : [];
    const makeNode = (
      node: ProductionPlan["nodes"][number],
      old: boolean,
      index: number,
    ): Node<PlanNodeData> => {
      const merchant = merchants.find(
        (item) => item.merchantId === node.merchantId,
      );
      const capability =
        candidates.find(
          (item) =>
            item.capabilityId === node.capabilityId &&
            item.merchantId === node.merchantId,
        ) ??
        merchant?.capabilities.find(
          (item) => item.capabilityId === node.capabilityId,
        );
      const offline =
        offlineMerchants.has(node.merchantId) || merchant?.status === "offline";
      const replacement =
        previousPlan &&
        previousPlan.planId !== plan.planId &&
        !previousPlan.nodes.some(
          (item) =>
            item.merchantId === node.merchantId &&
            item.capabilityId === node.capabilityId,
        );
      return {
        id: old ? `previous:${node.nodeId}` : node.nodeId,
        type: "production",
        position: old
          ? {
              x: index * 310,
              y: Math.max(0, ...[...positions.values()].map((p) => p.y)) + 220,
            }
          : (positions.get(node.nodeId) ?? { x: 0, y: 0 }),
        data: {
          label: capability?.capability.name ?? humanize(node.kind),
          merchant: merchant?.name ?? node.merchantId,
          cost: money(
            node.totalCost,
            old ? (previousPlan?.currency ?? plan.currency) : plan.currency,
          ),
          deadline: dateLabel(node.completesAt),
          quantity: node.quantity,
          status: old
            ? "Replaced · offline"
            : offline
              ? "Offline"
              : replacement
                ? "Replacement"
                : "Selected",
          unavailable: old || offline,
          onSelect: () => {
            onSelect(node);
            onSelectContext?.(
              planSelection(
                old && previousPlan ? previousPlan : plan,
                node.nodeId,
                plan.planId,
              ),
            );
          },
        },
      };
    };
    const nodes = [
      ...plan.nodes.map((node, index) => makeNode(node, false, index)),
      ...historical.map((node, index) => makeNode(node, true, index)),
    ];
    const edges: Edge[] = plan.edges.map((edge) => ({
      id: edge.edgeId,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      label: `${edge.material} · ${edge.quantity} ${edge.unit}`,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: "#778d83" },
      style: { stroke: "#778d83", strokeWidth: 1.5 },
      labelStyle: { fontSize: 10, fill: "#485a52" },
      labelBgStyle: { fill: "#f6f7f3" },
      labelBgPadding: [6, 4],
    }));
    return { nodes, edges };
  }, [
    plan,
    previousPlan,
    merchants,
    candidates,
    offlineMerchants,
    onSelect,
    onSelectContext,
  ]);

  return (
    <div className="decision-plan-graph">
      <div
        className="graph"
        role="region"
        aria-label="Production dependency graph. Select a merchant for quote and evidence."
      >
        <ReactFlow
          key={plan.planId}
          fitView
          fitViewOptions={{ padding: 0.16 }}
          minZoom={0.25}
          maxZoom={1.4}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          nodesFocusable={false}
          panOnScroll
          preventScrolling={false}
        >
          <Background gap={22} size={1} color="#cdd3cb" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="graph-legend">
        <span>
          <i /> Selected production path
        </span>
        <span>
          <i className="failed-dot" /> Offline / replaced
        </span>
        <span>Edges show the solver&apos;s material dependencies</span>
      </div>
      <details className="graph-text">
        <summary>View accessible production sequence</summary>
        <ol>
          {plan.nodes.map((node) => (
            <li key={node.nodeId}>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  onSelect(node);
                  onSelectContext?.(
                    planSelection(plan, node.nodeId, plan.planId),
                  );
                }}
              >
                {humanize(node.kind)} ·{" "}
                {merchants.find(
                  (merchant) => merchant.merchantId === node.merchantId,
                )?.name ?? node.merchantId}
              </button>{" "}
              — {money(node.totalCost, plan.currency)}
              <ul>
                {plan.edges
                  .filter((edge) => edge.fromNodeId === node.nodeId)
                  .map((edge) => (
                    <li key={edge.edgeId}>
                      {edge.quantity} {edge.unit} {edge.material} →{" "}
                      {plan.nodes.find(
                        (target) => target.nodeId === edge.toNodeId,
                      )?.merchantId ?? edge.toNodeId}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ol>
        {previousPlan &&
          previousPlan.planId !== plan.planId &&
          previousPlan.nodes.some((node) =>
            offlineMerchants.has(node.merchantId),
          ) && (
            <>
              <h3>Previous plan · offline suppliers</h3>
              <ul>
                {previousPlan.nodes
                  .filter((node) => offlineMerchants.has(node.merchantId))
                  .map((node) => (
                    <li key={node.nodeId}>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          onSelect(node);
                          onSelectContext?.(
                            planSelection(
                              previousPlan,
                              node.nodeId,
                              plan.planId,
                            ),
                          );
                        }}
                      >
                        {merchants.find(
                          (merchant) => merchant.merchantId === node.merchantId,
                        )?.name ?? node.merchantId}{" "}
                        · {money(node.totalCost, previousPlan.currency)} ·
                        previous plan
                      </button>
                    </li>
                  ))}
              </ul>
            </>
          )}
      </details>
    </div>
  );
}
