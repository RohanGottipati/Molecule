from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, uuid5

from ortools.sat.python import cp_model

from .config import OBJECTIVE_WEIGHTS
from .graph import validate_plan_graph
from .models import (
    CandidateCapability,
    ConstraintResult,
    PlanEdge,
    PlanNode,
    ProductionPlan,
    QuoteResponse,
    SolverInput,
)
from .relaxations import candidate_relaxations


def _duration_hours(candidate: CandidateCapability) -> float:
    if candidate.risk and candidate.risk.p95_hours is not None:
        return candidate.risk.p95_hours
    duration = candidate.capability.lead_time.max
    unit = candidate.capability.lead_time.unit
    if unit == "minutes":
        return duration / 60
    if unit == "days":
        return duration * 24
    return duration


def _required_kinds(data: SolverInput) -> list[str]:
    kinds: list[str] = ["SUPPLY"] if data.intent.desired_outputs else []
    for transformation in data.intent.transformations:
        lowered = transformation.kind.lower()
        kind = "ASSEMBLE" if "assembl" in lowered or "pack" in lowered else "TRANSFORM"
        if "fulfill" in lowered or "ship" in lowered:
            kind = "FULFILL"
        if kind not in kinds:
            kinds.append(kind)
    return kinds


def _compare(actual: object, operator: str, expected: object) -> bool:
    if operator == "eq":
        return actual == expected
    if operator == "neq":
        return actual != expected
    if operator == "contains":
        return str(expected).lower() in str(actual).lower()
    if operator == "in" and isinstance(expected, list):
        return actual in expected
    if operator in {"lt", "lte", "gt", "gte"}:
        try:
            left = float(actual)  # type: ignore[arg-type]
            right = float(expected)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return False
        return {
            "lt": left < right,
            "lte": left <= right,
            "gt": left > right,
            "gte": left >= right,
        }[operator]
    return False


def _hard_constraints_allowed(
    candidate: CandidateCapability,
    data: SolverInput,
) -> bool:
    attributes: dict[str, list[object]] = {}
    for port in candidate.capability.accepts + candidate.capability.produces:
        for field, value in port.attributes.items():
            attributes.setdefault(field.lower(), []).append(value)
    attributes["capability.kind"] = [candidate.capability.kind]
    attributes["merchantid"] = [candidate.merchant_id]

    for constraint in data.intent.hard_constraints:
        field = constraint.field.lower()
        values = attributes.get(field)
        if values is None and field == "material":
            values = [
                value
                for key, items in attributes.items()
                if key.endswith("material")
                for value in items
            ]
        if not values:
            return False
        if constraint.operator == "neq":
            if not all(_compare(value, "neq", constraint.value) for value in values):
                return False
        elif not any(_compare(value, constraint.operator, constraint.value) for value in values):
            return False
    return True


def _preference_penalty(candidate: CandidateCapability, data: SolverInput) -> int:
    searchable = " ".join(
        [
            candidate.capability.name,
            candidate.capability.description,
            *[
                str(value)
                for port in candidate.capability.accepts + candidate.capability.produces
                for value in port.attributes.values()
            ],
        ]
    ).lower()
    penalty = 0
    for preference in data.intent.soft_preferences:
        value = str(preference.value).lower()
        satisfied = value in searchable
        if preference.operator == "neq":
            satisfied = not satisfied
        if not satisfied:
            penalty += int(round(preference.weight * 1_000))
    return penalty


def _ports_compatible(
    upstream: CandidateCapability,
    downstream: CandidateCapability,
) -> bool:
    accepts = downstream.capability.accepts
    produces = upstream.capability.produces
    if not accepts:
        return True
    for accepted in accepts:
        for produced in produces:
            kind_matches = accepted.kind == produced.kind
            unit_matches = (
                accepted.unit is None or produced.unit is None or accepted.unit == produced.unit
            )
            if kind_matches and unit_matches:
                return True
    return False


def _unsat(data: SolverInput, explanation: str) -> ProductionPlan:
    plan_id = str(
        uuid5(
            NAMESPACE_URL,
            f"{data.order_id}:{data.intent.version}:{data.generation}:unsat",
        )
    )
    return ProductionPlan(
        plan_id=plan_id,
        order_id=data.order_id,
        intent_version=data.intent.version,
        status="UNSAT",
        nodes=[],
        edges=[],
        total_cost=0,
        currency=data.intent.currency,
        estimated_completion=None,
        risk_score=1,
        constraint_results=[
            ConstraintResult(
                constraint_id="feasibility",
                satisfied=False,
                explanation=explanation,
            )
        ],
        unsat_relaxations=candidate_relaxations(data.intent),
    )


def solve(data: SolverInput) -> ProductionPlan:
    quotes: dict[str, QuoteResponse] = {
        quote.capability_id: quote
        for quote in data.quotes
        if quote.status == "CAN_ACCEPT"
        and quote.currency == data.intent.currency
        and not quote.required_changes
    }
    eligible = [
        candidate
        for candidate in data.candidates
        if not candidate.blocked_reasons
        and candidate.capability_id in quotes
        and candidate.capability.quantity.min
        <= data.intent.quantity
        <= candidate.capability.quantity.max
        and (
            candidate.capability.capacity.available is None
            or candidate.capability.capacity.available >= data.intent.quantity
        )
        and _hard_constraints_allowed(candidate, data)
    ]
    required_kinds = _required_kinds(data)
    groups = {
        kind: [item for item in eligible if item.capability.kind == kind] for kind in required_kinds
    }
    if any(not candidates for candidates in groups.values()):
        return _unsat(
            data,
            "No quote-backed canonical candidate satisfies every required capability kind.",
        )

    now = datetime.fromisoformat(data.now.replace("Z", "+00:00"))
    deadline = datetime.fromisoformat(data.intent.deadline.replace("Z", "+00:00"))
    available_minutes = max(0, int((deadline - now).total_seconds() // 60))

    model = cp_model.CpModel()
    variables: dict[str, cp_model.IntVar] = {}
    costs: dict[str, int] = {}
    durations: dict[str, int] = {}
    for candidate in eligible:
        variables[candidate.capability_id] = model.new_bool_var(candidate.capability_id)
        quote = quotes[candidate.capability_id]
        total = (quote.unit_price or 0) * data.intent.quantity + quote.setup_fee
        costs[candidate.capability_id] = int(round(total * 100))
        durations[candidate.capability_id] = int(round(_duration_hours(candidate) * 60))

    for candidates in groups.values():
        model.add_exactly_one(variables[item.capability_id] for item in candidates)

    for index in range(len(required_kinds) - 1):
        upstream_group = groups[required_kinds[index]]
        downstream_group = groups[required_kinds[index + 1]]
        for upstream in upstream_group:
            for downstream in downstream_group:
                if not _ports_compatible(upstream, downstream):
                    model.add(
                        variables[upstream.capability_id] + variables[downstream.capability_id] <= 1
                    )

    selected_ids = {item.capability_id for candidates in groups.values() for item in candidates}
    total_cost = sum(costs[key] * variables[key] for key in selected_ids)
    total_duration = sum(durations[key] * variables[key] for key in selected_ids)
    if data.intent.budget_max is not None:
        model.add(total_cost <= int(round(data.intent.budget_max * 100)))
    model.add(total_duration <= available_minutes)

    risk_cost = sum(durations[key] * variables[key] for key in selected_ids)
    hop_cost = sum(variables[key] for key in selected_ids)
    preference_cost = sum(
        _preference_penalty(candidate, data) * variables[candidate.capability_id]
        for candidate in eligible
        if candidate.capability_id in selected_ids
    )
    fragility_cost = sum(
        (
            {"high": 0, "medium": 500, "low": 1_000}.get(
                candidate.risk.confidence if candidate.risk else "low",
                1_000,
            )
        )
        * variables[candidate.capability_id]
        for candidate in eligible
        if candidate.capability_id in selected_ids
    )
    change_cost = sum(
        (
            0
            if any(
                node_id.endswith(candidate.capability_id)
                for node_id in data.change_penalty_node_ids
            )
            else 1_000
        )
        * variables[candidate.capability_id]
        for candidate in eligible
        if candidate.capability_id in selected_ids
    )
    model.minimize(
        OBJECTIVE_WEIGHTS.cost * total_cost
        + OBJECTIVE_WEIGHTS.tail_risk * risk_cost
        + OBJECTIVE_WEIGHTS.preference_deviation * preference_cost
        + OBJECTIVE_WEIGHTS.fragility * fragility_cost
        + OBJECTIVE_WEIGHTS.merchant_hops * hop_cost
        + OBJECTIVE_WEIGHTS.plan_change * change_cost
    )
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    status = solver.solve(model)
    if status not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
        return _unsat(
            data,
            "Budget, p95 deadline, capacity, or material constraints are infeasible.",
        )

    chosen = sorted(
        [
            item
            for item in eligible
            if item.capability_id in selected_ids and solver.value(variables[item.capability_id])
        ],
        key=lambda item: required_kinds.index(item.capability.kind),
    )
    cursor = now.astimezone(UTC)
    nodes: list[PlanNode] = []
    for index, candidate in enumerate(chosen):
        quote = quotes[candidate.capability_id]
        duration = timedelta(hours=_duration_hours(candidate))
        complete = cursor + duration
        unit_cost = quote.unit_price or 0
        nodes.append(
            PlanNode(
                node_id=f"node-{index + 1}-{candidate.capability_id}",
                merchant_id=candidate.merchant_id,
                capability_id=candidate.capability_id,
                kind=candidate.capability.kind,
                quantity=data.intent.quantity,
                unit_cost=unit_cost,
                total_cost=unit_cost * data.intent.quantity + quote.setup_fee,
                starts_at=cursor.isoformat().replace("+00:00", "Z"),
                completes_at=complete.isoformat().replace("+00:00", "Z"),
            )
        )
        cursor = complete
    edges = [
        PlanEdge(
            edge_id=f"edge-{index + 1}",
            from_node_id=nodes[index].node_id,
            to_node_id=nodes[index + 1].node_id,
            material="work-in-progress",
            quantity=data.intent.quantity,
            unit="units",
        )
        for index in range(len(nodes) - 1)
    ]
    validate_plan_graph(nodes, edges)
    actual_cost = sum(node.total_cost for node in nodes)
    total_hours = max(0.0, (cursor - now).total_seconds() / 3600)
    available_hours = max(1.0, (deadline - now).total_seconds() / 3600)
    results = [
        ConstraintResult(
            constraint_id="budgetMax",
            satisfied=data.intent.budget_max is None or actual_cost <= data.intent.budget_max,
            actual_value=actual_cost,
            explanation="Total quote-backed cost is within the customer budget.",
        ),
        ConstraintResult(
            constraint_id="deadline",
            satisfied=cursor <= deadline,
            actual_value=cursor.isoformat().replace("+00:00", "Z"),
            explanation="Sequential p95 completion is within the requested deadline.",
        ),
        *[
            ConstraintResult(
                constraint_id=constraint.constraint_id,
                satisfied=True,
                explanation="The selected capabilities satisfy this hard constraint.",
            )
            for constraint in data.intent.hard_constraints
        ],
    ]
    fingerprint = ":".join(item.capability_id for item in chosen)
    plan_id = str(
        uuid5(
            NAMESPACE_URL,
            f"{data.order_id}:{data.intent.version}:{data.generation}:{fingerprint}",
        )
    )
    return ProductionPlan(
        plan_id=plan_id,
        order_id=data.order_id,
        intent_version=data.intent.version,
        status="VALID",
        nodes=nodes,
        edges=edges,
        total_cost=round(actual_cost, 2),
        currency=data.intent.currency,
        estimated_completion=cursor.isoformat().replace("+00:00", "Z"),
        risk_score=min(1, total_hours / available_hours),
        constraint_results=results,
        unsat_relaxations=[],
    )
