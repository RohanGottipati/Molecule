from copy import deepcopy
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_solver import candidate, payload

from app.cpsat import solve
from app.main import app
from app.models import SolverInput


def port(product: str, **attributes: object) -> dict:
    return {
        "kind": "product",
        "name": product,
        "unit": "units",
        "attributes": {"product": product, **attributes},
    }


def kit_payload() -> dict:
    value = payload(deadline="2026-09-26T03:59:59.000Z", budget=7000)
    value["intent"].update(
        {
            "quantity": 200,
            "desiredOutputs": [
                {"outputId": "hoodie", "name": "Hoodie", "attributes": {"product": "hoodie"}},
                {"outputId": "bottle", "name": "Bottle", "attributes": {"product": "bottle"}},
                {"outputId": "snacks", "name": "Snacks", "attributes": {"product": "snacks"}},
            ],
            "transformations": [
                {
                    "transformationId": "embroidery",
                    "kind": "embroidery",
                    "description": "Logo",
                    "inputRefs": ["hoodie"],
                    "outputRefs": ["embroidered-hoodie"],
                },
                {
                    "transformationId": "engraving",
                    "kind": "engraving",
                    "description": "Names",
                    "inputRefs": ["bottle"],
                    "outputRefs": ["engraved-bottle"],
                },
                {
                    "transformationId": "assembly",
                    "kind": "assembly",
                    "description": "Individual",
                    "inputRefs": ["embroidered-hoodie", "engraved-bottle", "snacks"],
                    "outputRefs": ["packaged-kit"],
                },
                {
                    "transformationId": "fulfillment",
                    "kind": "fulfillment",
                    "description": "Delivery",
                    "inputRefs": ["packaged-kit"],
                    "outputRefs": ["delivered-kit"],
                },
            ],
            "hardConstraints": [
                {
                    "constraintId": "black",
                    "field": "hoodie.color",
                    "operator": "eq",
                    "value": "black",
                },
                {
                    "constraintId": "vegan",
                    "field": "snacks.diet",
                    "operator": "eq",
                    "value": "vegan",
                },
                {
                    "constraintId": "leather",
                    "field": "material",
                    "operator": "not_contains",
                    "value": "leather",
                },
            ],
        }
    )
    specifications = [
        (
            "hoodie",
            "base-goods",
            12,
            "SUPPLY",
            [],
            port("hoodie", material="cotton", color="black"),
        ),
        ("bottle", "base-goods", 5, "SUPPLY", [], port("bottle", material="stainless steel")),
        ("snacks", "snack-box", 3, "SUPPLY", [], port("snacks", material="plant", diet="vegan")),
        (
            "stitch",
            "stitch-works",
            4,
            "TRANSFORM",
            [port("hoodie")],
            port("hoodie", operation="embroidery", material="cotton"),
        ),
        (
            "thread",
            "thread-forge",
            4.5,
            "TRANSFORM",
            [port("hoodie")],
            port("hoodie", operation="embroidery", material="cotton"),
        ),
        (
            "needle",
            "needle-north",
            5.1,
            "TRANSFORM",
            [port("hoodie")],
            port("hoodie", operation="embroidery", material="cotton"),
        ),
        (
            "laser",
            "laser-lab",
            3.2,
            "TRANSFORM",
            [port("bottle")],
            port("bottle", operation="engraving", material="stainless steel"),
        ),
        (
            "pack",
            "pack-ship",
            2,
            "ASSEMBLE",
            [
                port("hoodie", operation="embroidery"),
                port("bottle", operation="engraving"),
                port("snacks"),
            ],
            port("kit", packaging="individual"),
        ),
        ("ship", "pack-ship", 2, "FULFILL", [port("kit", packaging="individual")], port("kit")),
    ]
    value["candidates"] = []
    for key, merchant, price, kind, accepts, produces in specifications:
        item = candidate(key, merchant, price, 12)
        item["capability"].update(
            {
                "kind": kind,
                "accepts": accepts,
                "produces": [produces],
                "capacity": {
                    "available": 20 if key == "stitch" else 500,
                    "maximum": 500,
                    "period": "day",
                },
            }
        )
        value["candidates"].append(item)
    value["quotes"] = [
        {
            "merchantId": item["merchantId"],
            "capabilityId": item["capabilityId"],
            "status": "CAN_ACCEPT",
            "unitPrice": item["capability"]["pricing"]["unitPrice"],
            "setupFee": 40 if item["capabilityId"] == "laser" else 0,
            "currency": "CAD",
            "maxQuantity": 500,
            "requiredChanges": [],
            "confidence": 1,
            "explanation": "Synthetic verified fixture",
        }
        for item in value["candidates"]
    ]
    return value


@pytest.mark.parametrize("material", ["polyester", "60% cotton / 40% polyester"])
def test_material_exclusions_apply_inside_list_values(material: str) -> None:
    value = payload()
    value["intent"]["hardConstraints"] = [
        {
            "constraintId": "no-polyester",
            "field": "material",
            "operator": "not_contains",
            "value": "polyester",
        }
    ]
    for item in value["candidates"]:
        item["capability"]["produces"][0]["attributes"]["material"] = [material]
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"
    for item in value["candidates"]:
        item["capability"]["produces"][0]["attributes"]["material"] = ["100% cotton"]
    assert solve(SolverInput.model_validate(value)).status == "VALID"


@pytest.mark.parametrize("omit", ["accepts", "produces", "both"])
def test_missing_port_units_inherit_capability_quantity_units(omit: str) -> None:
    value = kit_payload()
    snacks = next(
        item["capability"] for item in value["candidates"] if item["capabilityId"] == "snacks"
    )
    pack = next(
        item["capability"] for item in value["candidates"] if item["capabilityId"] == "pack"
    )
    if omit in {"accepts", "both"}:
        pack["accepts"][2].pop("unit")
    if omit in {"produces", "both"}:
        snacks["produces"][0].pop("unit")
    assert solve(SolverInput.model_validate(value)).status == "VALID"
    snacks["quantity"]["unit"] = "kg"
    if "unit" in snacks["produces"][0]:
        snacks["produces"][0]["unit"] = "kg"
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"


def test_terminal_transformation_must_cover_all_declared_outputs() -> None:
    value = kit_payload()
    value["intent"]["transformations"][-1]["outputRefs"] = ["delivered-kit", "delivery-receipt"]
    ship = next(
        item["capability"] for item in value["candidates"] if item["capabilityId"] == "ship"
    )
    ship["produces"][0]["name"] = "delivered-kit"
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"
    ship["produces"].append(port("delivery-receipt"))
    assert solve(SolverInput.model_validate(value)).status == "VALID"


@pytest.mark.parametrize("bottle_inventory", [75, 100])
@pytest.mark.parametrize("hoodie_inventory", [50, 1000])
def test_inventory_is_aggregated_per_produced_port(
    bottle_inventory: int, hoodie_inventory: int
) -> None:
    value = payload(deadline="2026-09-23T12:00:00.000Z")
    value["candidates"] = value["candidates"][1:]
    value["quotes"] = value["quotes"][1:]
    value["candidates"][0]["capability"]["produces"] = [
        port("hoodie", inventory=hoodie_inventory),
        port("bottle", inventory=bottle_inventory),
    ]
    value["intent"]["desiredOutputs"].extend(
        [
            {"outputId": "bottle-a", "name": "Bottle"},
            {"outputId": "bottle-b", "name": "Bottle"},
        ]
    )
    assert solve(SolverInput.model_validate(value)).status == (
        "VALID" if bottle_inventory == 100 else "UNSAT"
    )


@pytest.mark.parametrize("inventory", [0, False, 1e308])
def test_unused_supplier_ports_do_not_constrain_requested_inventory(
    inventory: int | bool | float,
) -> None:
    value = payload()
    value["candidates"] = value["candidates"][1:]
    value["quotes"] = value["quotes"][1:]
    value["candidates"][0]["capability"]["produces"].append(port("bottle", inventory=inventory))
    assert solve(SolverInput.model_validate(value)).status == "VALID"


def test_plan_identity_changes_when_certified_quote_cost_or_schedule_changes() -> None:
    value = payload()
    original = solve(SolverInput.model_validate(value))
    value["quotes"][1]["unitPrice"] += 1
    repriced = solve(SolverInput.model_validate(value))
    value["quotes"][1]["completionEstimate"] = "2026-09-21T00:00:00.000Z"
    rescheduled = solve(SolverInput.model_validate(value))
    assert {result.status for result in [original, repriced, rescheduled]} == {"VALID"}
    assert original.total_cost != repriced.total_cost
    assert repriced.estimated_completion != rescheduled.estimated_completion
    assert len({result.plan_id for result in [original, repriced, rescheduled]}) == 3
    assert solve(SolverInput.model_validate(value)) == rescheduled


def test_full_kit_covers_every_requirement_with_real_edges_and_parallel_work() -> None:
    data = SolverInput.model_validate(kit_payload())
    result = solve(data)
    assert result.status == "VALID"
    assert result.total_cost == 6380
    assert len(result.nodes) == 7
    assert len(result.edges) == 6
    assert {n.capability_id for n in result.nodes} == {
        "hoodie",
        "bottle",
        "snacks",
        "thread",
        "laser",
        "pack",
        "ship",
    }
    nodes = {n.node_id: n for n in result.nodes}
    for edge in result.edges:
        source, target = nodes[edge.from_node_id], nodes[edge.to_node_id]
        assert datetime.fromisoformat(source.completes_at) <= datetime.fromisoformat(
            target.starts_at
        )
    supplies = [n for n in result.nodes if n.kind == "SUPPLY"]
    assert len({n.starts_at for n in supplies}) == 1
    assert {e.material for e in result.edges} == {
        "hoodie",
        "bottle",
        "snacks",
        "embroidered-hoodie",
        "engraved-bottle",
        "packaged-kit",
    }


def test_offline_recovery_preserves_components_and_replaces_only_embroidery() -> None:
    value = kit_payload()
    original = solve(SolverInput.model_validate(value))
    value["candidates"][4]["blockedReasons"] = ["merchant offline"]
    value["generation"] = 2
    value["changePenaltyNodeIds"] = [node.node_id for node in original.nodes]
    value["intent"]["hardConstraints"].append(
        {
            "constraintId": "polyester",
            "field": "material",
            "operator": "not_contains",
            "value": "polyester",
        }
    )
    replacement = solve(SolverInput.model_validate(value))
    assert replacement.status == "VALID"
    assert replacement.total_cost == 6500
    assert {n.capability_id for n in replacement.nodes} - {
        n.capability_id for n in original.nodes
    } == {"needle"}
    assert replacement.plan_id != original.plan_id
    assert replacement.estimated_completion == original.estimated_completion


@pytest.mark.parametrize("missing", ["hoodie", "bottle", "snacks", "laser", "pack", "ship"])
def test_missing_component_or_operation_never_certifies(missing: str) -> None:
    value = kit_payload()
    value["candidates"] = [c for c in value["candidates"] if c["capabilityId"] != missing]
    value["quotes"] = [q for q in value["quotes"] if q["capabilityId"] != missing]
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"


@pytest.mark.parametrize(
    "change",
    [
        "quote-null",
        "quote-duplicate",
        "quote-mismatch",
        "quote-limit",
        "quote-currency",
        "quote-late",
        "quote-counteroffer",
        "candidate-duplicate",
        "candidate-mismatch",
        "capacity-unknown",
        "capacity-zero",
        "inventory-short",
        "price-minimum",
        "setup-budget",
        "contradiction",
        "unknown-field",
        "unknown-scope",
        "conflicted-material",
        "port-material",
        "port-unit",
        "uncovered-input",
        "hard-rule",
        "cycle",
        "missing-ref",
        "duplicate-ref",
        "deadline",
        "quantity",
        "business-hours",
        "p95",
        "leadtime",
    ],
)
def test_adversarial_kit_rejection(change: str) -> None:
    value = kit_payload()
    hoodie, quote = value["candidates"][0]["capability"], value["quotes"][0]
    if change == "quote-null":
        quote["unitPrice"] = None
    elif change == "quote-duplicate":
        value["quotes"].append(deepcopy(quote))
    elif change == "quote-mismatch":
        quote["merchantId"] = "imposter"
    elif change == "quote-limit":
        quote["maxQuantity"] = 199
    elif change == "quote-currency":
        quote["currency"] = "USD"
    elif change == "quote-late":
        quote["completionEstimate"] = "2026-10-01T00:00:00Z"
    elif change == "quote-counteroffer":
        quote["status"] = "COUNTEROFFER"
    elif change == "candidate-duplicate":
        value["candidates"].append(deepcopy(value["candidates"][0]))
    elif change == "candidate-mismatch":
        hoodie["merchantId"] = "imposter"
    elif change == "capacity-unknown":
        hoodie["capacity"].pop("available")
    elif change == "capacity-zero":
        hoodie["capacity"]["available"] = 0
    elif change == "inventory-short":
        hoodie["produces"][0]["attributes"]["inventory"] = 199
    elif change == "price-minimum":
        hoodie["pricing"]["minimumTotal"] = 10000
    elif change == "setup-budget":
        quote["setupFee"] = 1000
    elif change == "contradiction":
        value["intent"]["hardConstraints"].append(
            {"constraintId": "white", "field": "hoodie.color", "operator": "eq", "value": "white"}
        )
    elif change in {"unknown-field", "unknown-scope"}:
        value["intent"]["hardConstraints"].append(
            {
                "constraintId": "unknown",
                "field": "warranty" if change == "unknown-field" else "hat.color",
                "operator": "eq",
                "value": "yes",
            }
        )
    elif change == "conflicted-material":
        hoodie["produces"][0]["attributes"]["material"] = {
            "status": "conflicted",
            "value": "cotton",
        }
    elif change == "port-material":
        for item in value["candidates"][3:6]:
            item["capability"]["accepts"][0]["attributes"]["material"] = "polyester"
    elif change == "port-unit":
        hoodie["produces"][0]["unit"] = "kg"
    elif change == "uncovered-input":
        value["candidates"][7]["capability"]["accepts"].append(port("hat"))
    elif change == "hard-rule":
        hoodie["hardRules"] = [
            {"constraintId": "rush-limit", "field": "quantity", "operator": "lte", "value": 40}
        ]
    elif change == "cycle":
        value["intent"]["transformations"][0]["inputRefs"] = ["packaged-kit"]
    elif change == "missing-ref":
        value["intent"]["transformations"][0]["inputRefs"] = ["absent"]
    elif change == "duplicate-ref":
        value["intent"]["transformations"][0]["outputRefs"] = ["hoodie"]
    elif change == "deadline":
        value["intent"]["deadline"] = "2026-09-19T13:00:00Z"
    elif change == "quantity":
        value["intent"]["desiredOutputs"][0]["quantity"] = 199
    elif change == "business-hours":
        hoodie["leadTime"]["unit"] = "business_hours"
    elif change == "p95":
        value["candidates"][0]["risk"]["p95Hours"] = 200
    elif change == "leadtime":
        hoodie["leadTime"]["max"] = 200
    assert solve(SolverInput.model_validate(value)).status == "UNSAT", change


def test_component_quantities_flow_through_transformations() -> None:
    value = kit_payload()
    value["intent"]["quantity"] = 100
    value["intent"]["desiredOutputs"][0]["quantity"] = 200
    result = solve(SolverInput.model_validate(value))
    assert result.status == "VALID"
    assert {n.capability_id: n.quantity for n in result.nodes} == {
        "hoodie": 200,
        "bottle": 100,
        "snacks": 100,
        "thread": 200,
        "laser": 100,
        "pack": 100,
        "ship": 100,
    }
    assert result.total_cost == 4860


def test_soft_preferences_do_not_become_hard_constraints() -> None:
    value = kit_payload()
    value["intent"]["softPreferences"] = [
        {
            "constraintId": "wish",
            "field": "hoodie.color",
            "operator": "eq",
            "value": "gold",
            "weight": 1,
        }
    ]
    assert solve(SolverInput.model_validate(value)).status == "VALID"


def test_material_exclusions_cover_transformation_materials_and_unknowns() -> None:
    for material in ["polyester", "unknown", {"status": "conflicted", "value": "cotton"}]:
        value = kit_payload()
        value["intent"]["hardConstraints"].append(
            {
                "constraintId": "no-polyester",
                "field": "material",
                "operator": "not_contains",
                "value": "polyester",
            }
        )
        for item in value["candidates"][3:6]:
            item["capability"]["produces"][0]["attributes"]["material"] = material
        assert solve(SolverInput.model_validate(value)).status == "UNSAT"


@pytest.mark.parametrize(
    "field,unit", [("hoodie.totalCost", None), ("quantity", "kg"), ("totalCost", "USD")]
)
def test_unsupported_scope_or_unit_never_bypasses_hard_constraints(field: str, unit: str) -> None:
    value = kit_payload()
    value["intent"]["hardConstraints"].append(
        {
            "constraintId": "unsupported",
            "field": field,
            "operator": "lte",
            "value": 10000,
            "unit": unit,
        }
    )
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"


def test_shared_inventory_and_quote_limit_cannot_be_double_counted() -> None:
    value = payload(deadline="2026-10-01T00:00:00Z", budget=10000)
    value["intent"]["quantity"] = 300
    value["intent"]["desiredOutputs"].append(
        {"outputId": "second", "name": "Hoodie", "attributes": {}}
    )
    value["candidates"] = value["candidates"][:1]
    value["quotes"] = value["quotes"][:1]
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"


@pytest.mark.parametrize(
    "operator,threshold,expected",
    [
        ("lt", 6380, "UNSAT"),
        ("lte", 6380, "VALID"),
        ("gt", 6500, "UNSAT"),
        ("eq", 6380, "VALID"),
        ("contains", 6380, "UNSAT"),
    ],
)
def test_budget_operators_are_enforced(operator: str, threshold: float, expected: str) -> None:
    value = kit_payload()
    value["intent"]["hardConstraints"].append(
        {
            "constraintId": "cost",
            "field": "totalCost",
            "operator": operator,
            "value": threshold,
        }
    )
    assert solve(SolverInput.model_validate(value)).status == expected


def test_unsupported_operator_and_invalid_timestamps_fail_the_http_boundary() -> None:
    client = TestClient(app)
    value = kit_payload()
    value["intent"]["hardConstraints"][0]["operator"] = "approximately"
    assert client.post("/solve", json=value).status_code == 422
    value = kit_payload()
    value["quotes"][0]["completionEstimate"] = "tomorrow"
    with pytest.raises(ValidationError):
        SolverInput.model_validate(value)
    value = kit_payload()
    result = client.post("/solve", json=value)
    assert result.status_code == 200
    assert result.json()["status"] == "VALID"
