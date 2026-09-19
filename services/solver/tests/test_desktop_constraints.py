from test_solver import payload

from app.cpsat import solve
from app.models import SolverInput


def test_material_exclusion_removes_blends_from_the_certified_plan() -> None:
    value = payload(deadline="2026-10-01T12:00:00.000Z")
    value["candidates"][0]["capability"]["produces"][0]["attributes"]["material"] = (
        "60% cotton / 40% Polyester"
    )
    value["intent"]["hardConstraints"] = [
        {
            "constraintId": "voice-no-polyester",
            "field": "material",
            "operator": "not_contains",
            "value": "polyester",
        }
    ]
    result = solve(SolverInput.model_validate(value))
    assert result.status == "VALID"
    assert {node.merchant_id for node in result.nodes} == {"merchant-b"}


def test_missing_material_cannot_satisfy_a_hard_exclusion() -> None:
    value = payload(deadline="2026-10-01T12:00:00.000Z")
    for item in value["candidates"]:
        item["capability"]["produces"][0]["attributes"] = {}
    value["intent"]["hardConstraints"] = [
        {
            "constraintId": "voice-no-polyester",
            "field": "material",
            "operator": "not_contains",
            "value": "polyester",
        }
    ]
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"
