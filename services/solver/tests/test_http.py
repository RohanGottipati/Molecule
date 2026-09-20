import pytest
from fastapi.testclient import TestClient
from test_solver import payload

from app.main import app


@pytest.mark.parametrize("quantity", [True, "50"])
def test_quantity_must_be_a_json_number(quantity: bool | str) -> None:
    value = payload()
    value["intent"]["quantity"] = quantity
    with TestClient(app) as client:
        response = client.post("/solve", json=value)
    assert response.status_code == 422


@pytest.mark.parametrize("budget", [2000, 1])
def test_missing_customer_details_require_answers_not_relaxations(budget: float) -> None:
    value = payload(budget=budget)
    value["intent"]["ambiguityFlags"] = [
        {
            "field": "artwork",
            "reason": "Missing logo",
            "question": "Please supply the logo artwork.",
        },
        {
            "field": "names",
            "reason": "Missing names",
            "question": "What names should be personalized?",
        },
        {"field": "shipping", "reason": "Please supply the fulfillment destinations."},
    ]
    with TestClient(app) as client:
        response = client.post("/solve", json=value)
        assert response.status_code == 200
        plan = response.json()
        assert plan["status"] == "UNSAT"
        assert plan["nodes"] == []
        assert plan["unsatRelaxations"] == []
        explanation = plan["constraintResults"][0]["explanation"]
        for flag in value["intent"]["ambiguityFlags"]:
            assert (flag.get("question") or flag["reason"]) in explanation

        value["intent"]["ambiguityFlags"] = []
        resolved = client.post("/solve", json=value)
        assert resolved.status_code == 200
        if budget == 1:
            assert resolved.json()["status"] == "UNSAT"
            assert resolved.json()["unsatRelaxations"]
        else:
            assert resolved.json()["status"] == "VALID"


@pytest.mark.parametrize("field", ["budget", "price", "duration", "inventory", "constraint"])
def test_unrepresentable_solver_numbers_fail_closed(field: str) -> None:
    value = payload()
    if field == "budget":
        value["intent"]["budgetMax"] = 1e308
    elif field == "price":
        value["quotes"][1]["unitPrice"] = 1e308
    elif field == "duration":
        value["candidates"][1]["capability"]["leadTime"]["max"] = 1e308
    elif field == "inventory":
        value["candidates"][1]["capability"]["produces"][0]["attributes"]["inventory"] = 1e308
    else:
        value["intent"]["hardConstraints"] = [
            {"constraintId": "budget", "field": "totalCost", "operator": "lte", "value": 1e308}
        ]
    with TestClient(app) as client:
        response = client.post("/solve", json=value)
    assert response.status_code == 200
    assert response.json()["status"] == "UNSAT"
    assert response.json()["constraintResults"][0]["satisfied"] is False


def test_relaxations_do_not_overflow_the_timestamp_range() -> None:
    value = payload(deadline="9999-12-31T23:59:59.000Z", budget=1.7e308)
    value["candidates"] = []
    value["quotes"] = []
    with TestClient(app) as client:
        response = client.post("/solve", json=value)
    assert response.status_code == 200
    plan = response.json()
    assert plan["status"] == "UNSAT"
    assert plan["unsatRelaxations"] == [
        {
            "constraintId": "quantity",
            "proposedValue": 37,
            "explanation": "Reduce the quantity by 25%.",
        }
    ]


def test_unsat_response_omits_absent_completion() -> None:
    value = payload()
    value["candidates"] = []
    value["quotes"] = []
    with TestClient(app) as client:
        response = client.post("/solve", json=value)
    assert response.status_code == 200
    plan = response.json()
    assert plan["status"] == "UNSAT"
    assert "estimatedCompletion" not in plan
    assert plan["nodes"] == []
    assert plan["constraintResults"][0]["satisfied"] is False
    assert plan["unsatRelaxations"]


def test_valid_response_retains_completion() -> None:
    with TestClient(app) as client:
        response = client.post("/solve", json=payload())
    assert response.status_code == 200
    plan = response.json()
    assert plan["status"] == "VALID"
    assert isinstance(plan["estimatedCompletion"], str)
    assert plan["nodes"]
