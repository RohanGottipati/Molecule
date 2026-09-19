import type { ProductionPlan } from "@molecule/contracts";

export function planLayers(plan: ProductionPlan): ProductionPlan["nodes"][] {
  const layers: ProductionPlan["nodes"][] = [];
  let remaining = [...plan.nodes];
  while (remaining.length) {
    const ids = new Set(remaining.map((node) => node.nodeId));
    const layer = remaining.filter(
      (node) =>
        !plan.edges.some(
          (edge) => edge.toNodeId === node.nodeId && ids.has(edge.fromNodeId),
        ),
    );
    if (!layer.length) {
      layers.push(remaining);
      break;
    }
    layers.push(layer);
    const placed = new Set(layer.map((node) => node.nodeId));
    remaining = remaining.filter((node) => !placed.has(node.nodeId));
  }
  return layers;
}
