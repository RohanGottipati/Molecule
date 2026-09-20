from .models import CandidateCapability, CapabilityPort, Constraint, ProductIntent
from .requirements import Requirement, normalized


def known(value: object) -> bool:
    if value is None or isinstance(value, dict):
        return False
    if isinstance(value, str):
        return normalized(value) not in {"", "unknown", "conflicted", "unresolved"}
    if isinstance(value, list):
        return bool(value) and all(known(item) for item in value)
    return isinstance(value, (int, float, bool))


def compare(actual: object, operator: str, expected: object) -> bool:
    if not known(actual) or not known(expected):
        return False
    if isinstance(actual, str) and isinstance(expected, str):
        actual, expected = normalized(actual), normalized(expected)
    if operator == "eq":
        return (
            type(actual) is type(expected)
            and actual == expected
            or (
                isinstance(actual, (int, float))
                and not isinstance(actual, bool)
                and isinstance(expected, (int, float))
                and not isinstance(expected, bool)
                and actual == expected
            )
        )
    if operator == "neq":
        return not compare(actual, "eq", expected)
    if operator in {"contains", "not_contains"}:
        if isinstance(actual, str) and isinstance(expected, str):
            contained = expected in actual
        elif isinstance(actual, list):
            contained = any(
                compare(
                    item,
                    "contains" if isinstance(item, str) and isinstance(expected, str) else "eq",
                    expected,
                )
                for item in actual
            )
        else:
            return False
        return contained if operator == "contains" else not contained
    if operator == "in":
        return isinstance(expected, list) and any(compare(actual, "eq", v) for v in expected)
    if operator in {"lt", "lte", "gt", "gte"}:
        if (
            isinstance(actual, bool)
            or isinstance(expected, bool)
            or not isinstance(actual, (int, float))
            or not isinstance(expected, (int, float))
        ):
            return False
        return {
            "lt": actual < expected,
            "lte": actual <= expected,
            "gt": actual > expected,
            "gte": actual >= expected,
        }[operator]
    return False


def product_matches(port: CapabilityPort, product: str) -> bool:
    identity = port.attributes.get("product", port.name)
    return compare(identity, "eq", product)


def matching_ports(candidate: CandidateCapability, need: Requirement) -> list[CapabilityPort]:
    if candidate.capability.kind != need.kind:
        return []
    ports = candidate.capability.produces
    if need.kind == "SUPPLY":
        return [
            port
            for port in ports
            if product_matches(port, need.operation)
            and all(
                compare(port.attributes.get(key), "eq", value)
                for key, value in need.attributes.items()
            )
        ]
    if need.kind == "TRANSFORM":
        return [
            port
            for port in ports
            if compare(port.attributes.get("operation", port.name), "eq", need.operation)
            or compare(candidate.capability.name, "eq", need.operation)
        ]
    return ports


def scoped_field(constraint: Constraint, need: Requirement) -> str | None:
    field = constraint.field
    if "." in field and field not in {"capability.kind", "capacity.available"}:
        scope, field = field.rsplit(".", 1)
        if normalized(scope) not in {normalized(need.key), normalized(need.operation)}:
            return None
    elif need.kind != "SUPPLY" and field not in {
        "quantity",
        "currency",
        "merchantId",
        "capability.kind",
        "capacity.available",
    }:
        if not (need.kind == "TRANSFORM" and field == "material"):
            return None
    return field


def satisfies(
    constraint: Constraint,
    candidate: CandidateCapability,
    need: Requirement,
    ports: list[CapabilityPort],
    intent: ProductIntent,
    *,
    merchant_rule: bool = False,
) -> bool:
    field = constraint.field if merchant_rule else scoped_field(constraint, need)
    if field is None:
        return True
    if constraint.unit is not None:
        unit = {
            "quantity": candidate.capability.quantity.unit,
            "capacity.available": candidate.capability.quantity.unit,
            "totalCost": intent.currency,
            "budgetMax": intent.currency,
            "currency": intent.currency,
        }.get(field)
        if unit is None or not compare(unit, "eq", constraint.unit):
            return False
    if field in {"budgetMax", "totalCost", "deadline"} and not merchant_rule:
        return constraint.field == field
    values: list[object]
    fixed: dict[str, object] = {
        "quantity": need.quantity,
        "currency": intent.currency,
        "merchantId": candidate.merchant_id,
        "capability.kind": candidate.capability.kind,
        "capacity.available": candidate.capability.capacity.available,
        "budgetMax": intent.budget_max,
        "deadline": intent.deadline,
    }
    if field in fixed:
        values = [fixed[field]]
    elif merchant_rule:
        scope, _, attribute = field.rpartition(".")
        outputs = [
            output
            for output in intent.desired_outputs
            if not scope or scope in {output.output_id, output.attributes.get("product")}
        ]
        values = [output.attributes.get(attribute or field) for output in outputs]
        if field == "assets":
            values = [[asset.asset_id for asset in intent.assets]]
    else:
        values = [port.attributes.get(field) for port in ports]
    return bool(values) and all(
        compare(value, constraint.operator, constraint.value) for value in values
    )


def ports_compatible(
    produced: CapabilityPort,
    accepted: CapabilityPort,
    produced_unit: str,
    accepted_unit: str,
) -> bool:
    return (
        normalized(produced.kind) == normalized(accepted.kind)
        and product_matches(produced, str(accepted.attributes.get("product", accepted.name)))
        and (produced.unit or produced_unit) == (accepted.unit or accepted_unit)
        and all(
            compare(produced.attributes.get(key), "eq", value)
            for key, value in accepted.attributes.items()
        )
    )
