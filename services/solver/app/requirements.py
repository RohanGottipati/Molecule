from dataclasses import dataclass

import networkx as nx
from pydantic import JsonValue

from .models import ProductIntent


@dataclass(frozen=True)
class Requirement:
    key: str
    kind: str
    operation: str
    quantity: int
    attributes: dict[str, JsonValue]
    inputs: tuple[str, ...]
    outputs: tuple[str, ...]


@dataclass(frozen=True)
class Dependency:
    source: str
    target: str
    reference: str


def normalized(value: str) -> str:
    return value.strip().casefold().replace("_", " ").replace("-", " ")


def operation_kind(operation: str) -> str:
    return {
        "assembly": "ASSEMBLE",
        "packaging": "ASSEMBLE",
        "fulfillment": "FULFILL",
        "shipping": "FULFILL",
    }.get(normalized(operation), "TRANSFORM")


def requirements(intent: ProductIntent) -> tuple[list[Requirement], list[Dependency]]:
    needs: dict[str, Requirement] = {}
    producers: dict[str, str] = {}
    for output in intent.desired_outputs:
        if output.output_id in needs:
            raise ValueError("duplicate component IDs")
        needs[output.output_id] = Requirement(
            output.output_id,
            "SUPPLY",
            str(output.attributes.get("product", output.name)),
            output.quantity or intent.quantity,
            output.attributes,
            (),
            (output.output_id,),
        )
        producers[output.output_id] = output.output_id
    for transformation in intent.transformations:
        key = transformation.transformation_id
        if key in needs:
            raise ValueError("duplicate requirement IDs")
        if not transformation.input_refs or not transformation.output_refs:
            raise ValueError(f"{key} has missing input or output references")
        if len(set(transformation.input_refs)) != len(transformation.input_refs):
            raise ValueError(f"{key} has duplicate input references")
        for reference in transformation.output_refs:
            if reference in producers:
                raise ValueError(f"multiple producers for {reference}; use unique stage references")
            producers[reference] = key
        needs[key] = Requirement(
            key,
            operation_kind(transformation.kind),
            transformation.kind,
            intent.quantity,
            {},
            tuple(transformation.input_refs),
            tuple(transformation.output_refs),
        )
    edges: list[Dependency] = []
    graph: nx.DiGraph[str] = nx.DiGraph()
    graph.add_nodes_from(needs)
    for need in needs.values():
        for reference in need.inputs:
            if reference not in producers:
                raise ValueError(f"missing producer for {reference}")
            edges.append(Dependency(producers[reference], need.key, reference))
            graph.add_edge(producers[reference], need.key)
    if not nx.is_directed_acyclic_graph(graph):
        raise ValueError("requirement graph must be acyclic")
    ordered: list[Requirement] = []
    for key in nx.lexicographical_topological_sort(graph):
        need = needs[key]
        if need.kind in {"TRANSFORM", "FULFILL"}:
            quantities = {needs[producers[ref]].quantity for ref in need.inputs}
            if len(quantities) != 1:
                raise ValueError(f"{key} has ambiguous input quantities")
            need = Requirement(
                need.key,
                need.kind,
                need.operation,
                quantities.pop(),
                need.attributes,
                need.inputs,
                need.outputs,
            )
            needs[key] = need
        if need.kind == "ASSEMBLE" and any(
            needs[producers[ref]].quantity < need.quantity
            or needs[producers[ref]].quantity % need.quantity != 0
            for ref in need.inputs
        ):
            raise ValueError("assembly quantities must provide whole components for each kit")
        ordered.append(need)
    # A physical output cannot be consumed twice without a quantity/allocation contract.
    if len([e.reference for e in edges]) != len({e.reference for e in edges}):
        raise ValueError("a component is consumed more than once")
    return ordered, edges
