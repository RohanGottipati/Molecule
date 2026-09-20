from datetime import datetime, timedelta
from math import isfinite

from .models import ConstraintRelaxation, ProductIntent


def candidate_relaxations(intent: ProductIntent) -> list[ConstraintRelaxation]:
    if intent.ambiguity_flags:
        return []
    relaxations: list[ConstraintRelaxation] = []
    if intent.budget_max is not None and isfinite(intent.budget_max * 1.25):
        relaxations.append(
            ConstraintRelaxation(
                constraint_id="budgetMax",
                proposed_value=round(intent.budget_max * 1.25, 2),
                explanation="Increase the maximum budget by 25%.",
            )
        )
    deadline = datetime.fromisoformat(intent.deadline.replace("Z", "+00:00"))
    try:
        extended = deadline + timedelta(hours=24)
    except OverflowError:
        extended = None
    if extended is not None:
        relaxations.append(
            ConstraintRelaxation(
                constraint_id="deadline",
                proposed_value=extended.isoformat().replace("+00:00", "Z"),
                explanation="Extend the deadline by 24 hours.",
            )
        )
    if intent.quantity > 1:
        relaxations.append(
            ConstraintRelaxation(
                constraint_id="quantity",
                proposed_value=max(1, intent.quantity * 3 // 4),
                explanation="Reduce the quantity by 25%.",
            )
        )
    return relaxations
