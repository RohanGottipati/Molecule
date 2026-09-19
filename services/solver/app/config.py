from dataclasses import dataclass


@dataclass(frozen=True)
class ObjectiveWeights:
    cost: int = 40
    tail_risk: int = 30
    preference_deviation: int = 15
    fragility: int = 10
    merchant_hops: int = 5
    plan_change: int = 25


OBJECTIVE_WEIGHTS = ObjectiveWeights()
