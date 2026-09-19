from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator, model_validator


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(word.capitalize() for word in rest)


class ContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        allow_inf_nan=False,
        strict=True,
    )


class Constraint(ContractModel):
    constraint_id: str
    field: str
    operator: Literal["eq", "neq", "lt", "lte", "gt", "gte", "in", "contains", "not_contains"]
    value: JsonValue
    unit: str | None = None
    description: str | None = None


class WeightedPreference(Constraint):
    weight: float = Field(ge=0, le=1)


class DesiredOutput(ContractModel):
    output_id: str
    name: str
    quantity: int | None = Field(default=None, gt=0)
    attributes: dict[str, JsonValue] = Field(default_factory=dict)


class TransformationNeed(ContractModel):
    transformation_id: str
    kind: str
    description: str
    input_refs: list[str] = Field(default_factory=list)
    output_refs: list[str] = Field(default_factory=list)


class AssetRef(ContractModel):
    asset_id: str
    name: str | None = None
    mime_type: str | None = None
    url: str | None = None
    checksum: str | None = None
    provider_file_id: str | None = None


class AmbiguityFlag(ContractModel):
    field: str
    reason: str
    question: str | None = None


class ProductIntent(ContractModel):
    intent_id: str
    version: int = Field(gt=0)
    quantity: int = Field(gt=0)
    deadline: str
    currency: Literal["CAD", "USD"]
    budget_max: float | None = Field(default=None, gt=0)
    desired_outputs: list[DesiredOutput] = Field(min_length=1)
    transformations: list[TransformationNeed]
    hard_constraints: list[Constraint]
    soft_preferences: list[WeightedPreference]
    assets: list[AssetRef] = Field(default_factory=list)
    ambiguity_flags: list[AmbiguityFlag] = Field(default_factory=list)

    @field_validator("deadline")
    @classmethod
    def valid_deadline(cls, value: str) -> str:
        return timestamp(value)


class CapabilityPort(ContractModel):
    kind: str
    name: str
    unit: str | None = None
    attributes: dict[str, JsonValue] = Field(default_factory=dict)


class QuantityRange(ContractModel):
    min: float = Field(ge=0)
    max: float = Field(gt=0)
    unit: str

    @model_validator(mode="after")
    def range_is_ordered(self) -> QuantityRange:
        if self.max < self.min:
            raise ValueError("max must be greater than or equal to min")
        return self


class PricingRule(ContractModel):
    currency: Literal["CAD", "USD"]
    unit_price: float | None = Field(default=None, ge=0)
    setup_fee: float = Field(default=0, ge=0)
    minimum_total: float | None = Field(default=None, ge=0)


class DurationRange(ContractModel):
    min: float = Field(ge=0)
    max: float = Field(ge=0)
    unit: Literal["minutes", "hours", "business_hours", "days"]

    @model_validator(mode="after")
    def ordered(self) -> DurationRange:
        if self.max < self.min:
            raise ValueError("duration max must be greater than or equal to min")
        return self


class CapacityRule(ContractModel):
    available: float | None = Field(default=None, ge=0)
    maximum: float | None = Field(default=None, gt=0)
    period: Literal["hour", "day", "week"] | None = None
    as_of: str | None = None

    @model_validator(mode="after")
    def consistent(self) -> CapacityRule:
        if self.as_of is not None:
            timestamp(self.as_of)
        if (
            self.available is not None
            and self.maximum is not None
            and self.available > self.maximum
        ):
            raise ValueError("available capacity cannot exceed maximum")
        return self


class MerchantCapability(ContractModel):
    capability_id: str
    merchant_id: str
    kind: Literal["SUPPLY", "TRANSFORM", "ASSEMBLE", "FULFILL"]
    name: str
    description: str
    accepts: list[CapabilityPort]
    produces: list[CapabilityPort]
    quantity: QuantityRange
    pricing: PricingRule
    lead_time: DurationRange
    capacity: CapacityRule
    hard_rules: list[Constraint]
    soft_rules: list[Constraint]
    source_claim_ids: list[str]


class CandidateRisk(ContractModel):
    p50_hours: float | None = Field(default=None, ge=0)
    p95_hours: float | None = Field(default=None, ge=0)
    p99_hours: float | None = Field(default=None, ge=0)
    sample_count: int = Field(ge=0)
    confidence: Literal["low", "medium", "high"]

    @model_validator(mode="after")
    def ordered(self) -> CandidateRisk:
        values = [v for v in [self.p50_hours, self.p95_hours, self.p99_hours] if v is not None]
        if values != sorted(values):
            raise ValueError("risk percentiles must be ordered")
        return self


class SelectedCatalogItem(ContractModel):
    binding_id: str
    product_id: str
    variant_id: str
    sku: str
    item_kind: Literal["physical", "service"]
    shop_domain: str | None = None
    variant_gid: str | None = None


class ResourceInterval(ContractModel):
    starts_at: str
    completes_at: str

    @model_validator(mode="after")
    def ordered(self) -> ResourceInterval:
        timestamp(self.starts_at)
        timestamp(self.completes_at)
        if datetime.fromisoformat(self.completes_at.replace("Z", "+00:00")) <= datetime.fromisoformat(self.starts_at.replace("Z", "+00:00")):
            raise ValueError("Resource intervals must have positive duration")
        return self


class CatalogResourceReference(ContractModel):
    resource_id: str
    kind: Literal["inventory", "processing"]
    unit: str
    units_per_item: float = Field(gt=0)
    available: float = Field(ge=0)
    period_minutes: int | None = Field(default=None, gt=0)
    observed_at: str
    source_reference: str
    occupied_intervals: list[ResourceInterval] | None = None

    @model_validator(mode="after")
    def consistent(self) -> CatalogResourceReference:
        timestamp(self.observed_at)
        if (self.kind == "processing") != (self.period_minutes is not None):
            raise ValueError("Only processing resources require periodMinutes")
        return self


class CatalogReferences(ContractModel):
    catalog_version: str | None = None
    selected_item: SelectedCatalogItem | None = None
    resource_refs: list[CatalogResourceReference] | None = None
    required_asset_ids: list[str] | None = None
    transfer_minutes: int | None = Field(default=None, ge=0)
    synthetic: bool | None = None


class CandidateCapability(CatalogReferences):
    capability_id: str
    merchant_id: str
    score: float
    capability: MerchantCapability
    risk: CandidateRisk | None = None
    blocked_reasons: list[str] = Field(default_factory=list)


class ConstraintPatch(ContractModel):
    constraint_id: str | None = None
    operation: Literal["add", "replace", "remove"]
    path: str
    value: JsonValue = None


class QuoteResponse(CatalogReferences):
    quoted_quantity: int | None = Field(default=None, gt=0)
    merchant_id: str
    capability_id: str
    status: Literal["CAN_ACCEPT", "COUNTEROFFER", "DECLINE"]
    unit_price: float | None = Field(default=None, ge=0)
    setup_fee: float = Field(default=0, ge=0)
    currency: Literal["CAD", "USD"]
    max_quantity: int | None = Field(default=None, gt=0)
    completion_estimate: str | None = None
    reservation_id: str | None = None
    required_changes: list[ConstraintPatch] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    explanation: str = Field(max_length=600)

    @field_validator("completion_estimate")
    @classmethod
    def valid_completion(cls, value: str | None) -> str | None:
        return timestamp(value) if value is not None else None


class SolverInput(ContractModel):
    order_id: str
    trace_id: str
    generation: int = Field(ge=0)
    now: str
    intent: ProductIntent
    candidates: list[CandidateCapability]
    quotes: list[QuoteResponse]
    change_penalty_node_ids: list[str] = Field(default_factory=list)

    @field_validator("now")
    @classmethod
    def valid_now(cls, value: str) -> str:
        return timestamp(value)


class PlanNode(CatalogReferences):
    customization_assets: list[AssetRef] | None = None
    node_id: str
    merchant_id: str
    capability_id: str
    kind: Literal["SUPPLY", "TRANSFORM", "ASSEMBLE", "FULFILL"]
    quantity: float = Field(gt=0)
    unit_cost: float = Field(ge=0)
    total_cost: float = Field(ge=0)
    starts_at: str | None = None
    completes_at: str | None = None


class PlanEdge(ContractModel):
    edge_id: str
    from_node_id: str
    to_node_id: str
    material: str
    quantity: float = Field(gt=0)
    unit: str


class ConstraintResult(ContractModel):
    constraint_id: str
    satisfied: bool
    actual_value: JsonValue = None
    explanation: str


class ConstraintRelaxation(ContractModel):
    constraint_id: str
    proposed_value: JsonValue
    explanation: str


class ProductionPlan(ContractModel):
    plan_id: str
    order_id: str
    intent_version: int = Field(gt=0)
    status: Literal["VALID", "UNSAT"]
    nodes: list[PlanNode]
    edges: list[PlanEdge]
    total_cost: float = Field(ge=0)
    currency: Literal["CAD", "USD"]
    estimated_completion: str | None = None
    risk_score: float = Field(ge=0, le=1)
    constraint_results: list[ConstraintResult]
    unsat_relaxations: list[ConstraintRelaxation] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_means_satisfied(self) -> ProductionPlan:
        if self.status == "VALID" and any(not item.satisfied for item in self.constraint_results):
            raise ValueError("a VALID plan cannot contain an unsatisfied constraint")
        return self


def timestamp(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return value
