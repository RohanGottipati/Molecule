"use client";

import type {
  CandidateCapability,
  MerchantTwinSummary,
  ProductionPlan,
} from "@molecule/contracts";
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  Position,
  ReactFlow,
  getBezierPath,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { planSelection, type PlanSelection } from "../lib/decisionPlan";
import { kindColorVar, type PlanNodeKind } from "../lib/planVisuals";
import { dateLabel, graphPositions, humanize, money } from "../lib/workspace";
import { PlanKindIcon } from "./PlanKindIcon";

type PlanNodeData = {
  label: string;
  merchant: string;
  kind: PlanNodeKind;
  cost: string;
  unit: string | undefined;
  quantity: number;
  status: string;
  tone: "neutral" | "primary" | "warning";
  unavailable: boolean;
  selected: boolean;
  onSelect: () => void;
};

function ProductionNode({ data }: NodeProps<Node<PlanNodeData>>) {
  return (
    <button
      className={`production-node nodrag ${data.unavailable ? "node-failed" : ""} ${data.selected ? "node-selected" : ""}`}
      aria-pressed={data.selected}
      onClick={data.onSelect}
      type="button"
    >
      <span className="node-glow-ring" aria-hidden="true" />
      <Handle type="target" position={Position.Left} />
      <span
        className="node-kind-tile"
        style={{ color: kindColorVar[data.kind] }}
        aria-hidden="true"
      >
        <PlanKindIcon kind={data.kind} />
      </span>
      <span className="node-content">
        <span className="node-head">
          <strong title={data.merchant}>{data.merchant}</strong>
          <span className={`node-status node-status-${data.tone}`}>
            {data.tone !== "neutral" && <i aria-hidden="true" />}
            {data.status}
          </span>
        </span>
        <span className="node-subtitle" title={data.label}>
          {data.label}
        </span>
        <span className="node-metadata">
          <span className="node-kind">{data.kind}</span>
          <span className="node-separator" aria-hidden="true">
            ·
          </span>
          <span>{data.cost}</span>
          <span className="node-separator" aria-hidden="true">
            ·
          </span>
          <span>
            {data.quantity.toLocaleString("en-GB")}{" "}
            {data.unit ?? "(unit unknown)"}
          </span>
        </span>
      </span>
      <Handle type="source" position={Position.Right} />
    </button>
  );
}

const nodeTypes = { production: ProductionNode };

type ProductionEdgeData = { animated: boolean };

export function ProductionEdge({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps<Edge<ProductionEdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <path d={edgePath} className="plan-edge-glow" fill="none" />
      <path d={edgePath} className="plan-edge-base" fill="none" />
      {data?.animated && (
        <path
          d={edgePath}
          className="plan-edge-flow mol-edge-flow"
          fill="none"
        />
      )}
      <BaseEdge
        path={edgePath}
        labelX={labelX}
        labelY={labelY}
        label={label}
        labelStyle={labelStyle}
        labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
        style={{ stroke: "transparent" }}
      />
    </>
  );
}

const edgeTypes = { production: ProductionEdge };

export function PlanGraph({
  plan,
  previousPlan,
  merchants,
  candidates,
  offlineMerchants,
  onSelect,
  onSelectContext,
  overlay,
}: {
  overlay?: ReactNode;
  plan: ProductionPlan;
  previousPlan: ProductionPlan | null;
  merchants: MerchantTwinSummary[];
  candidates: CandidateCapability[];
  offlineMerchants: Set<string>;
  onSelect: (node: ProductionPlan["nodes"][number]) => void;
  onSelectContext?: (selection: PlanSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      const resolved = resolveNode(
        node,
        merchants,
        candidates,
        offlineMerchants,
      );
      const offline = resolved.offline;
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
              x: index * 540,
              y: Math.max(0, ...[...positions.values()].map((p) => p.y)) + 260,
            }
          : (positions.get(node.nodeId) ?? { x: 0, y: 0 }),
        data: {
          label: resolved.label,
          merchant: resolved.merchantName,
          kind: node.kind,
          cost: money(
            node.totalCost,
            old ? (previousPlan?.currency ?? plan.currency) : plan.currency,
          ),
          unit: resolved.unit,
          quantity: node.quantity,
          status: old
            ? "Replaced · offline"
            : offline
              ? "Offline"
              : replacement
                ? "Replacement"
                : "Selected",
          tone:
            old || offline ? "warning" : replacement ? "primary" : "neutral",
          unavailable: old || offline,
          selected:
            selectedId === (old ? `previous:${node.nodeId}` : node.nodeId),
          onSelect: () => {
            setSelectedId(old ? `previous:${node.nodeId}` : node.nodeId);
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
    const edges: Edge<ProductionEdgeData>[] = plan.edges.map((edge) => ({
      id: edge.edgeId,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      label: `${edge.quantity.toLocaleString("en-GB")} ${edge.unit}`,
      type: "production",
      zIndex: 0,
      data: { animated: true },
      labelStyle: { fontSize: 11, fill: "#627081", fontWeight: 500 },
      labelBgStyle: {
        fill: "#fafcfc",
        stroke: "#e3e8ed",
        strokeWidth: 1,
      },
      labelBgPadding: [10, 5],
      labelBgBorderRadius: 8,
    }));
    return { nodes, edges };
  }, [
    selectedId,
    plan,
    previousPlan,
    merchants,
    candidates,
    offlineMerchants,
    onSelect,
    onSelectContext,
  ]);
  const [renderedNodes, setRenderedNodes, onNodesChange] = useNodesState(nodes);
  useEffect(() => {
    setRenderedNodes((current) => {
      const measurements = new Map(
        current.map((node) => [node.id, node.measured]),
      );
      return nodes.map((node) => ({
        ...node,
        measured: measurements.get(node.id),
      }));
    });
  }, [nodes, setRenderedNodes]);

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
          minZoom={0.12}
          maxZoom={1.4}
          nodes={renderedNodes}
          onNodesChange={onNodesChange}
          onPaneClick={() => setSelectedId(null)}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          nodesFocusable={false}
          panOnScroll
          preventScrolling={false}
        >
          <Background gap={28} size={1} color="#d5dde1" />
          <Controls showInteractive={false} orientation="horizontal" />
        </ReactFlow>
        <svg
          width={0}
          height={0}
          style={{ position: "absolute" }}
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="plan-edge-gradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#4fd4e4" />
              <stop offset="50%" stopColor="#5b87f7" />
              <stop offset="100%" stopColor="#a07bff" />
            </linearGradient>
          </defs>
        </svg>
        {overlay}
      </div>
      <div className="graph-legend">
        <span>
          <i /> Selected production path
        </span>
        <span>
          <i className="failed-dot" /> Offline / replaced
        </span>
        {(["SUPPLY", "TRANSFORM", "ASSEMBLE", "FULFILL"] as const).map(
          (kind) => (
            <span key={kind}>
              <i style={{ background: kindColorVar[kind] }} /> {humanize(kind)}
            </span>
          ),
        )}
        <span>Flow shows material dependencies, not execution status</span>
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

export function resolveNode(
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
    unit: capability?.capability.quantity.unit,
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
      {plan.nodes.map((node) => {
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
            <span
              className="row-index"
              style={{ color: kindColorVar[node.kind] }}
            >
              <PlanKindIcon kind={node.kind} />
            </span>
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
            <span className="timeline-date">{dateLabel(node.completesAt)}</span>
            <span className="timeline-rail" aria-hidden="true">
              <span
                className={`timeline-icon ${resolved.offline ? "offline" : ""}`}
                style={
                  resolved.offline
                    ? undefined
                    : { color: kindColorVar[node.kind] }
                }
              >
                <PlanKindIcon kind={node.kind} />
              </span>
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
