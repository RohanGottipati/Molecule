from collections.abc import Iterable

import networkx as nx

from .models import PlanEdge, PlanNode


def validate_plan_graph(nodes: Iterable[PlanNode], edges: Iterable[PlanEdge]) -> None:
    node_list = list(nodes)
    edge_list = list(edges)
    node_ids = {node.node_id for node in node_list}
    if any(
        edge.from_node_id not in node_ids or edge.to_node_id not in node_ids for edge in edge_list
    ):
        raise ValueError("production graph contains an unknown node")
    graph: nx.DiGraph[str] = nx.DiGraph()
    graph.add_nodes_from(node_ids)
    graph.add_edges_from((edge.from_node_id, edge.to_node_id) for edge in edge_list)
    if not nx.is_directed_acyclic_graph(graph):
        raise ValueError("production graph must be acyclic")
