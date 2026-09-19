from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal
from math import ceil
from uuid import NAMESPACE_URL, uuid5

from ortools.sat.python import cp_model

from .config import OBJECTIVE_WEIGHTS
from .constraints import matching_ports, ports_compatible, satisfies, scoped_field
from .graph import validate_plan_graph
from .models import (
    CandidateCapability,
    CapabilityPort,
    Constraint,
    ConstraintResult,
    PlanEdge,
    PlanNode,
    ProductionPlan,
    QuoteResponse,
    SolverInput,
)
from .relaxations import candidate_relaxations
from .requirements import Dependency, Requirement, requirements


@dataclass(frozen=True)
class Choice:
    candidate: CandidateCapability
    quote: QuoteResponse
    ports: list[CapabilityPort]
    cents: int
    minutes: int
    earliest_completion: int


def _date(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must have timezone")
    return parsed.astimezone(UTC)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _cents(value: float, rounding: str = ROUND_CEILING) -> int:
    return int((Decimal(str(value)) * 100).to_integral_value(rounding=rounding))


def _choice(
    candidate: CandidateCapability,
    quote: QuoteResponse,
    need: Requirement,
    data: SolverInput,
) -> Choice | None:
    capability = candidate.capability
    available = capability.capacity.available
    ports = matching_ports(candidate, need)
    if (
        candidate.blocked_reasons
        or not ports
        or candidate.merchant_id != capability.merchant_id
        or candidate.capability_id != capability.capability_id
        or quote.merchant_id != candidate.merchant_id
        or quote.status != "CAN_ACCEPT"
        or quote.required_changes
        or quote.currency != data.intent.currency
        or capability.pricing.currency != data.intent.currency
        or quote.unit_price is None
        or available is None
        or available <= 0
        or not capability.quantity.min <= need.quantity <= capability.quantity.max
        or quote.max_quantity is not None
        and quote.max_quantity < need.quantity
        or capability.lead_time.unit == "business_hours"
        or capability.capacity.as_of is not None
        and _date(capability.capacity.as_of) > _date(data.now)
        or need.kind != "SUPPLY"
        and not capability.accepts
    ):
        return None
    if (need.kind == "SUPPLY" or capability.capacity.period is None) and available < need.quantity:
        return None
    if any(
        not satisfies(rule, candidate, need, ports, data.intent)
        for rule in data.intent.hard_constraints
    ):
        return None
    if any(
        not satisfies(rule, candidate, need, ports, data.intent, merchant_rule=True)
        for rule in capability.hard_rules
    ):
        return None
    for port in ports:
        if port.unit is not None and port.unit != capability.quantity.unit:
            return None
        inventory = port.attributes.get("inventory")
        if inventory is not None and (
            isinstance(inventory, bool)
            or not isinstance(inventory, (float, int))
            or inventory < need.quantity
        ):
            return None
    lead = capability.lead_time
    duration = lead.max * {"minutes": 1, "hours": 60, "days": 1440}[lead.unit]
    if candidate.risk and candidate.risk.p95_hours is not None:
        duration = max(duration, candidate.risk.p95_hours * 60)
    if need.kind != "SUPPLY" and capability.capacity.period is not None:
        period = {"hour": 60, "day": 1440, "week": 10080}[capability.capacity.period]
        duration = max(duration, need.quantity / available * period)
    total = Decimal(str(quote.unit_price)) * need.quantity + Decimal(str(quote.setup_fee))
    total = max(total, Decimal(str(capability.pricing.minimum_total or 0)))
    completion = (
        max(0, ceil((_date(quote.completion_estimate) - _date(data.now)).total_seconds() / 60))
        if quote.completion_estimate
        else 0
    )
    return Choice(
        candidate,
        quote,
        ports,
        int((total * 100).to_integral_value(rounding=ROUND_CEILING)),
        ceil(duration),
        completion,
    )


def _unsat(data: SolverInput, explanation: str) -> ProductionPlan:
    return ProductionPlan(
        plan_id=str(
            uuid5(NAMESPACE_URL, f"{data.order_id}:{data.intent.version}:{data.generation}:unsat")
        ),
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
            ConstraintResult(constraint_id="feasibility", satisfied=False, explanation=explanation)
        ],
        unsat_relaxations=candidate_relaxations(data.intent),
    )


def _edge_ports(choice: Choice, need: Requirement, reference: str) -> list[CapabilityPort]:
    if len(need.outputs) == 1:
        return choice.ports
    return [port for port in choice.ports if port.name == reference]


def _numeric_constraint(
    model: cp_model.CpModel,
    expression: cp_model.LinearExpr,
    constraint: Constraint,
    scale: int,
) -> bool:
    value = constraint.value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    exact = Decimal(str(value)) * scale
    floor = int(exact.to_integral_value(rounding=ROUND_FLOOR))
    ceiling = int(exact.to_integral_value(rounding=ROUND_CEILING))
    match constraint.operator:
        case "lte":
            model.add(expression <= floor)
        case "lt":
            model.add(expression <= ceiling - 1)
        case "gte":
            model.add(expression >= ceiling)
        case "gt":
            model.add(expression >= floor + 1)
        case "eq":
            if floor != ceiling:
                return False
            model.add(expression == floor)
        case "neq":
            if floor == ceiling:
                model.add(expression != floor)
        case _:
            return False
    return True


def solve(data: SolverInput) -> ProductionPlan:
    if data.intent.ambiguity_flags:
        return _unsat(data, "Customer requirements still need clarification.")
    try:
        needs, dependencies = requirements(data.intent)
    except ValueError as error:
        return _unsat(data, str(error))
    candidate_ids = [candidate.capability_id for candidate in data.candidates]
    quote_ids = [quote.capability_id for quote in data.quotes]
    if len(set(candidate_ids)) != len(candidate_ids) or len(set(quote_ids)) != len(quote_ids):
        return _unsat(
            data, "Duplicate candidate or quote identity; supply one current quote per capability."
        )
    quotes = {quote.capability_id: quote for quote in data.quotes}
    if any(quote.capability_id not in candidate_ids for quote in data.quotes):
        return _unsat(data, "A quote references an unknown capability.")
    for constraint in data.intent.hard_constraints:
        if not any(scoped_field(constraint, need) is not None for need in needs):
            return _unsat(
                data, f"Constraint {constraint.constraint_id} has no matching requirement."
            )
    groups: dict[str, list[Choice]] = {}
    for need in needs:
        groups[need.key] = [
            choice
            for candidate in sorted(data.candidates, key=lambda c: c.capability_id)
            if candidate.capability_id in quotes
            and (choice := _choice(candidate, quotes[candidate.capability_id], need, data))
            is not None
        ]
        if not groups[need.key]:
            return _unsat(
                data, f"No quote-backed canonical candidate covers requirement {need.key}."
            )

    now, deadline = _date(data.now), _date(data.intent.deadline)
    horizon = int((deadline - now).total_seconds() // 60)
    if horizon < 0:
        return _unsat(data, "The deadline precedes the planning timestamp.")
    model = cp_model.CpModel()
    variables: dict[tuple[str, int], cp_model.IntVar] = {}
    starts: dict[str, cp_model.IntVar] = {}
    ends: dict[str, cp_model.IntVar] = {}
    intervals: dict[str, list[cp_model.IntervalVar]] = {}
    by_key = {need.key: need for need in needs}
    for need in needs:
        starts[need.key] = model.new_int_var(0, horizon, f"start:{need.key}")
        ends[need.key] = model.new_int_var(0, horizon, f"end:{need.key}")
        for index, choice in enumerate(groups[need.key]):
            variable = model.new_bool_var(f"{need.key}:{choice.candidate.capability_id}")
            variables[need.key, index] = variable
            model.add(ends[need.key] >= choice.earliest_completion).only_enforce_if(variable)
            interval = model.new_optional_interval_var(
                starts[need.key],
                choice.minutes,
                ends[need.key],
                variable,
                f"interval:{need.key}:{index}",
            )
            intervals.setdefault(choice.candidate.capability_id, []).append(interval)
        model.add_exactly_one(variables[need.key, i] for i in range(len(groups[need.key])))
    for capability_id, jobs in intervals.items():
        model.add_no_overlap(jobs)
        choices = [
            (need, i, choice)
            for need in needs
            for i, choice in enumerate(groups[need.key])
            if choice.candidate.capability_id == capability_id
        ]
        capability = choices[0][2].candidate.capability
        quote = choices[0][2].quote
        total_quantity = sum(need.quantity * variables[need.key, i] for need, i, _ in choices)
        model.add(total_quantity <= int(capability.quantity.max))
        if quote.max_quantity is not None:
            model.add(total_quantity <= quote.max_quantity)
        if capability.kind == "SUPPLY" or capability.capacity.period is None:
            model.add(total_quantity <= int(capability.capacity.available or 0))
        for port in choices[0][2].ports:
            inventory = port.attributes.get("inventory")
            if isinstance(inventory, (float, int)):
                model.add(total_quantity <= int(inventory))

    for edge in dependencies:
        model.add(starts[edge.target] >= ends[edge.source])
        for i, upstream in enumerate(groups[edge.source]):
            produced = _edge_ports(upstream, by_key[edge.source], edge.reference)
            for j, downstream in enumerate(groups[edge.target]):
                if not any(
                    ports_compatible(a, b)
                    for a in produced
                    for b in downstream.candidate.capability.accepts
                ):
                    model.add(variables[edge.source, i] + variables[edge.target, j] <= 1)
    for need in needs:
        incoming = [edge for edge in dependencies if edge.target == need.key]
        for index, choice in enumerate(groups[need.key]):
            for accepted in choice.candidate.capability.accepts:
                supporting = [
                    variables[edge.source, i]
                    for edge in incoming
                    for i, upstream in enumerate(groups[edge.source])
                    if any(
                        ports_compatible(port, accepted)
                        for port in _edge_ports(upstream, by_key[edge.source], edge.reference)
                    )
                ]
                model.add(sum(supporting) >= variables[need.key, index])

    total_cost = cp_model.LinearExpr.sum(
        [
            choice.cents * variables[key, i]
            for key, group in groups.items()
            for i, choice in enumerate(group)
        ]
    )
    makespan = model.new_int_var(0, horizon, "completion")
    model.add_max_equality(makespan, list(ends.values()))
    if data.intent.budget_max is not None:
        model.add(total_cost <= _cents(data.intent.budget_max, ROUND_FLOOR))
    for constraint in data.intent.hard_constraints:
        if constraint.field in {"budgetMax", "totalCost"}:
            if not _numeric_constraint(model, total_cost, constraint, 100):
                return _unsat(data, f"Unsupported budget constraint {constraint.constraint_id}.")
        elif constraint.field == "deadline":
            if not isinstance(constraint.value, str):
                return _unsat(data, "Deadline constraints require a timestamp.")
            try:
                minutes = (_date(constraint.value) - now).total_seconds() / 60
            except ValueError:
                return _unsat(data, "Deadline constraint has an invalid timestamp.")
            rule = constraint.model_copy(update={"value": minutes})
            if not _numeric_constraint(model, makespan, rule, 1):
                return _unsat(data, f"Unsupported deadline constraint {constraint.constraint_id}.")
    penalties = []
    for need in needs:
        for i, choice in enumerate(groups[need.key]):
            candidate = choice.candidate
            preference = sum(
                round(rule.weight * 1000)
                for rule in data.intent.soft_preferences
                if not satisfies(rule, candidate, need, choice.ports, data.intent)
            )
            fragility = {"high": 0, "medium": 500, "low": 1000}[
                candidate.risk.confidence if candidate.risk else "low"
            ]
            change = (
                1000
                if data.change_penalty_node_ids
                and (
                    f"node-{need.key}-{candidate.capability_id}" not in data.change_penalty_node_ids
                )
                else 0
            )
            penalties.append(
                variables[need.key, i]
                * (
                    OBJECTIVE_WEIGHTS.preference_deviation * preference
                    + OBJECTIVE_WEIGHTS.fragility * fragility
                    + OBJECTIVE_WEIGHTS.plan_change * change
                )
            )
    model.minimize(
        OBJECTIVE_WEIGHTS.cost * total_cost
        + OBJECTIVE_WEIGHTS.tail_risk * makespan
        + sum(penalties)
        + sum(starts.values())
    )
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    solver.parameters.max_time_in_seconds = 10
    status = solver.solve(model)
    if status not in {cp_model.OPTIMAL, cp_model.FEASIBLE}:
        return _unsat(
            data,
            "No certified solution within the budget, dependency, p95 deadline, "
            "capacity and port constraints (or solver search limit).",
        )
    nodes: list[PlanNode] = []
    node_by_key: dict[str, PlanNode] = {}
    units: dict[str, str] = {}
    for need in needs:
        chosen = next(
            choice
            for i, choice in enumerate(groups[need.key])
            if solver.value(variables[need.key, i])
        )
        assert chosen.quote.unit_price is not None
        node = PlanNode(
            node_id=f"node-{need.key}-{chosen.candidate.capability_id}",
            merchant_id=chosen.candidate.merchant_id,
            capability_id=chosen.candidate.capability_id,
            kind=chosen.candidate.capability.kind,
            quantity=need.quantity,
            unit_cost=chosen.quote.unit_price,
            total_cost=chosen.cents / 100,
            starts_at=_iso(now + timedelta(minutes=solver.value(starts[need.key]))),
            completes_at=_iso(now + timedelta(minutes=solver.value(ends[need.key]))),
        )
        nodes.append(node)
        node_by_key[need.key] = node
        units[need.key] = chosen.candidate.capability.quantity.unit
    edges = [_plan_edge(edge, node_by_key, by_key, units) for edge in dependencies]
    validate_plan_graph(nodes, edges)
    completion = _iso(now + timedelta(minutes=solver.value(makespan)))
    actual_cost = solver.value(total_cost) / 100
    results = [
        ConstraintResult(
            constraint_id="budgetMax",
            satisfied=True,
            actual_value=actual_cost,
            explanation="Total accepted quote costs include setup and minimum totals.",
        ),
        ConstraintResult(
            constraint_id="deadline",
            satisfied=True,
            actual_value=completion,
            explanation="Dependency schedule includes p95, lead time and capacity.",
        ),
        *[
            ConstraintResult(
                constraint_id=f"coverage:{need.key}",
                satisfied=True,
                actual_value=node_by_key[need.key].capability_id,
                explanation="Requirement has one compatible quote-backed capability.",
            )
            for need in needs
        ],
        *[
            ConstraintResult(
                constraint_id=rule.constraint_id,
                satisfied=True,
                explanation="Hard constraint enforced on its applicable requirements.",
            )
            for rule in data.intent.hard_constraints
        ],
    ]
    fingerprint = ":".join(node.node_id for node in nodes)
    return ProductionPlan(
        plan_id=str(
            uuid5(
                NAMESPACE_URL,
                f"{data.order_id}:{data.intent.version}:{data.generation}:{fingerprint}",
            )
        ),
        order_id=data.order_id,
        intent_version=data.intent.version,
        status="VALID",
        nodes=nodes,
        edges=edges,
        total_cost=actual_cost,
        currency=data.intent.currency,
        estimated_completion=completion,
        risk_score=min(1, solver.value(makespan) / max(1, horizon)),
        constraint_results=results,
        unsat_relaxations=[],
    )


def _plan_edge(
    edge: Dependency,
    nodes: dict[str, PlanNode],
    needs: dict[str, Requirement],
    units: dict[str, str],
) -> PlanEdge:
    return PlanEdge(
        edge_id=f"edge-{edge.source}-{edge.target}-{edge.reference}",
        from_node_id=nodes[edge.source].node_id,
        to_node_id=nodes[edge.target].node_id,
        material=edge.reference,
        quantity=needs[edge.source].quantity,
        unit=units[edge.source],
    )
