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
}: {
  plan: ProductionPlan;
  previousPlan: ProductionPlan | null;
  merchants: MerchantTwinSummary[];
  candidates: CandidateCapability[];
  offlineMerchants: Set<string>;
  onSelect: (node: ProductionPlan["nodes"][number]) => void;
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
              x: index * 400,
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
          onSelect: () => onSelect(node),
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
      label: `${humanize(edge.material)} · ${edge.quantity} ${edge.unit}`,
      type: "smoothstep",
      zIndex: 1,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#778d83" },
      style: { stroke: "#778d83", strokeWidth: 1.5 },
      labelStyle: { fontSize: 10, fill: "#3a4a41", fontWeight: 550 },
      labelBgStyle: { fill: "#fffefa", stroke: "#dde3d8", strokeWidth: 1 },
      labelBgPadding: [7, 5],
      labelBgBorderRadius: 4,
    }));
    return { nodes, edges };
  }, [plan, previousPlan, merchants, candidates, offlineMerchants, onSelect]);

  return (
    <>
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
                onClick={() => onSelect(node)}
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
      </details>
    </>
  );
}

const illustrativeSteps = [
  { label: "Component supplier", role: "Input" },
  { label: "Component supplier", role: "Input" },
  { label: "Component supplier", role: "Input" },
  { label: "Assemble", role: "Process" },
  { label: "Deliver", role: "Output" },
];

function NetworkCaption() {
  return (
    <div className="production-list-caption">
      <h3>Your temporary company starts here</h3>
      <p>
        Describe what should exist. The server discovers merchants, gathers
        quotes and asks the solver to validate a connected production plan.
      </p>
      <small>Illustrative structure · no merchants selected yet</small>
    </div>
  );
}

type ProductionViewProps = {
  plan: ProductionPlan | null;
  merchants: MerchantTwinSummary[];
  candidates: CandidateCapability[];
  offlineMerchants: Set<string>;
  onSelect: (node: ProductionPlan["nodes"][number]) => void;
};

function resolveNode(
  node: ProductionPlan["nodes"][number],
  merchants: MerchantTwinSummary[],
  candidates: CandidateCapability[],
  offlineMerchants: Set<string>,
) {
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
  return {
    label: capability?.capability.name ?? humanize(node.kind),
    merchantName: merchant?.name ?? node.merchantId,
    offline,
  };
}

export function ProductionListView({
  plan,
  merchants,
  candidates,
  offlineMerchants,
  onSelect,
}: ProductionViewProps) {
  if (!plan || !plan.nodes.length)
    return (
      <>
        <div className="production-list">
          {illustrativeSteps.map((step, index) => (
            <div
              className="production-list-row illustrative"
              key={`${step.label}:${index}`}
            >
              <span className="row-index">{index + 1}</span>
              <div className="row-main">
                <strong>{step.label}</strong>
                <small>{step.role} · not started</small>
              </div>
            </div>
          ))}
        </div>
        <NetworkCaption />
      </>
    );
  return (
    <div className="production-list">
      {plan.nodes.map((node, index) => {
        const resolved = resolveNode(
          node,
          merchants,
          candidates,
          offlineMerchants,
        );
        return (
          <button
            type="button"
            key={node.nodeId}
            className={`production-list-row ${resolved.offline ? "offline" : ""}`}
            onClick={() => onSelect(node)}
          >
            <span className="row-index">{index + 1}</span>
            <div className="row-main">
              <strong>{resolved.label}</strong>
              <small>
                {resolved.merchantName} ·{" "}
                {resolved.offline ? "Offline" : "Selected"}
              </small>
            </div>
            <div className="row-meta">
              {money(node.totalCost, plan.currency)}
              <small>Due {dateLabel(node.completesAt)}</small>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function ProductionTimelineView({
  plan,
  merchants,
  candidates,
  offlineMerchants,
  onSelect,
}: ProductionViewProps) {
  if (!plan || !plan.nodes.length)
    return (
      <>
        <div className="production-timeline">
          {illustrativeSteps.map((step, index) => (
            <div className="timeline-row" key={`${step.label}:${index}`}>
              <span className="timeline-date">Not started</span>
              <span className="timeline-rail" aria-hidden="true">
                <span className="timeline-dot" />
                <span className="timeline-line" />
              </span>
              <div className="timeline-content">
                <strong>{step.label}</strong>
                <small>{step.role}</small>
              </div>
            </div>
          ))}
        </div>
        <NetworkCaption />
      </>
    );
  const ordered = [...plan.nodes].sort((a, b) =>
    (a.completesAt ?? "").localeCompare(b.completesAt ?? ""),
  );
  return (
    <div className="production-timeline">
      {ordered.map((node) => {
        const resolved = resolveNode(
          node,
          merchants,
          candidates,
          offlineMerchants,
        );
        return (
          <div className="timeline-row" key={node.nodeId}>
            <span className="timeline-date">
              {dateLabel(node.completesAt)}
            </span>
            <span className="timeline-rail" aria-hidden="true">
              <span
                className={`timeline-dot ${resolved.offline ? "offline" : ""}`}
              />
              <span className="timeline-line" />
            </span>
            <button
              type="button"
              className="timeline-content"
              onClick={() => onSelect(node)}
            >
              <strong>{resolved.label}</strong>
              <small>
                {resolved.merchantName} · {money(node.totalCost, plan.currency)}
              </small>
            </button>
          </div>
        );
      })}
    </div>
  );
}
