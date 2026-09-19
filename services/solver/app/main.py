from fastapi import FastAPI

from .cpsat import solve
from .models import ProductionPlan, SolverInput

app = FastAPI(title="Molecule Solver", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/solve", response_model=ProductionPlan, response_model_by_alias=True)
def solve_route(data: SolverInput) -> ProductionPlan:
    return solve(data)
