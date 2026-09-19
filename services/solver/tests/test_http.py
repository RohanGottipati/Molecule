from fastapi.testclient import TestClient
from test_solver import payload

from app.main import app


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
