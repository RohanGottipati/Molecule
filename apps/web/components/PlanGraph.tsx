"use client";

import type { ProductionPlan } from "@molecule/contracts";
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

type PlanNodeData = { label: string; merchant: string; cost: string };

function ProductionNode({ data }: NodeProps<Node<PlanNodeData>>) {
  return (
    <div className="production-node">
      <Handle type="target" position={Position.Left} />
      <span>{data.label}</span>
      <strong>{data.merchant}</strong>
      <small>{data.cost}</small>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function PlanGraph({ plan }: { plan: ProductionPlan }) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node<PlanNodeData>[] = plan.nodes.map((node, index) => ({
      id: node.nodeId,
      type: "production",
      position: { x: index * 250, y: index % 2 === 0 ? 40 : 150 },
      data: {
        label: node.kind,
        merchant: node.merchantId,
        cost: `${plan.currency} ${node.totalCost.toFixed(2)}`,
      },
    }));
    const edges: Edge[] = plan.edges.map((edge) => ({
      id: edge.edgeId,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      label: `${edge.quantity} ${edge.unit}`,
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
    return { nodes, edges };
  }, [plan]);

  return (
    <div className="graph" aria-label="Production plan graph">
      <ReactFlow
        fitView
        nodes={nodes}
        edges={edges}
        nodeTypes={{ production: ProductionNode }}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
