import pytest

from app.cpsat import solve
from app.graph import validate_plan_graph
from app.models import PlanEdge, PlanNode, SolverInput


def candidate(capability_id: str, merchant_id: str, price: float, p95: float) -> dict:
    return {
        "capabilityId": capability_id,
        "merchantId": merchant_id,
        "score": 0.9,
        "capability": {
            "capabilityId": capability_id,
            "merchantId": merchant_id,
            "kind": "SUPPLY",
            "name": "Cotton hoodie supply",
            "description": "Black cotton hoodies",
            "accepts": [],
            "produces": [
                {
                    "kind": "product",
                    "name": "hoodie",
                    "attributes": {"material": "cotton"},
                }
            ],
            "quantity": {"min": 1, "max": 500, "unit": "units"},
            "pricing": {"currency": "CAD", "unitPrice": price, "setupFee": 0},
            "leadTime": {"min": 1, "max": p95, "unit": "hours"},
            "capacity": {"available": 500, "maximum": 500, "period": "day"},
            "hardRules": [],
            "softRules": [],
            "sourceClaimIds": ["claim-1"],
        },
        "risk": {"p50Hours": p95 / 2, "p95Hours": p95, "sampleCount": 100, "confidence": "high"},
        "blockedReasons": [],
    }


def payload(deadline: str = "2026-09-21T12:00:00.000Z", budget: float = 2000) -> dict:
    candidates = [
        candidate("cheap-risky", "merchant-a", 5, 72),
        candidate("safe", "merchant-b", 7, 24),
    ]
    return {
        "orderId": "order-1",
        "traceId": "trace-1",
        "generation": 1,
        "now": "2026-09-19T12:00:00.000Z",
        "intent": {
            "intentId": "7b423f38-4ee8-45e8-ab06-f70476201b0e",
            "version": 1,
            "quantity": 50,
            "deadline": deadline,
            "currency": "CAD",
            "budgetMax": budget,
            "desiredOutputs": [{"outputId": "out-1", "name": "Hoodie", "attributes": {}}],
            "transformations": [],
            "hardConstraints": [],
            "softPreferences": [],
            "assets": [],
            "ambiguityFlags": [],
        },
        "candidates": candidates,
        "quotes": [
            {
                "merchantId": item["merchantId"],
                "capabilityId": item["capabilityId"],
                "status": "CAN_ACCEPT",
                "unitPrice": item["capability"]["pricing"]["unitPrice"],
                "setupFee": 0,
                "currency": "CAD",
                "requiredChanges": [],
                "confidence": 0.9,
                "explanation": "Available",
            }
            for item in candidates
        ],
        "changePenaltyNodeIds": [],
    }


def test_tail_risk_excludes_cheapest_candidate() -> None:
    result = solve(SolverInput.model_validate(payload()))
    assert result.status == "VALID"
    assert result.nodes[0].capability_id == "safe"


def test_impossible_deadline_returns_relaxations() -> None:
    result = solve(SolverInput.model_validate(payload(deadline="2026-09-19T13:00:00.000Z")))
    assert result.status == "UNSAT"
    assert result.unsat_relaxations


def test_same_input_is_deterministic() -> None:
    data = SolverInput.model_validate(payload())
    assert solve(data).model_dump() == solve(data).model_dump()


def test_zero_capacity_is_not_treated_as_unknown() -> None:
    value = payload()
    for item in value["candidates"]:
        item["capability"]["capacity"]["available"] = 0
    result = solve(SolverInput.model_validate(value))
    assert result.status == "UNSAT"


def test_cyclic_plan_graph_is_rejected() -> None:
    nodes = [
        PlanNode(
            node_id="a",
            merchant_id="m1",
            capability_id="c1",
            kind="SUPPLY",
            quantity=1,
            unit_cost=1,
            total_cost=1,
        ),
        PlanNode(
            node_id="b",
            merchant_id="m2",
            capability_id="c2",
            kind="TRANSFORM",
            quantity=1,
            unit_cost=1,
            total_cost=1,
        ),
    ]
    edges = [
        PlanEdge(
            edge_id="a-b",
            from_node_id="a",
            to_node_id="b",
            material="item",
            quantity=1,
            unit="units",
        ),
        PlanEdge(
            edge_id="b-a",
            from_node_id="b",
            to_node_id="a",
            material="item",
            quantity=1,
            unit="units",
        ),
    ]
    with pytest.raises(ValueError, match="acyclic"):
        validate_plan_graph(nodes, edges)


def test_currency_mismatch_is_rejected_at_boundary() -> None:
    value = payload()
    for quote in value["quotes"]:
        quote["currency"] = "USD"
    result = solve(SolverInput.model_validate(value))
    assert result.status == "UNSAT"


def test_unknown_hard_fact_remains_unknown_and_is_not_certified() -> None:
    value = payload()
    value["intent"]["hardConstraints"] = [
        {
            "constraintId": "fire-rating",
            "field": "fireRating",
            "operator": "eq",
            "value": "Class A",
        }
    ]
    result = solve(SolverInput.model_validate(value))
    assert result.status == "UNSAT"
