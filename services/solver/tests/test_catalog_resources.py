from copy import deepcopy

from test_solver import payload

from app.cpsat import solve
from app.models import SolverInput


def catalog_payload() -> dict:
    value = payload()
    value["candidates"] = [value["candidates"][1]]
    value["quotes"] = [value["quotes"][1]]
    item = value["candidates"][0]
    item.update(
        {
            "catalogVersion": "v1",
            "selectedItem": {
                "bindingId": "b1",
                "productId": "p1",
                "variantId": "v1",
                "sku": "HOODIE",
                "itemKind": "physical",
            },
            "resourceRefs": [
                {
                    "resourceId": "stock",
                    "kind": "inventory",
                    "unit": "units",
                    "unitsPerItem": 1,
                    "available": 70,
                    "observedAt": value["now"],
                    "sourceReference": "fixture:stock",
                }
            ],
            "transferMinutes": 60,
            "requiredAssetIds": [],
            "synthetic": True,
        }
    )
    value["quotes"][0].update({k: item[k] for k in ("catalogVersion", "selectedItem")})
    value["quotes"][0]["quotedQuantity"] = 50
    return value


def test_catalog_identity_reaches_plan_and_quote_must_match() -> None:
    value = catalog_payload()
    plan = solve(SolverInput.model_validate(value))
    assert plan.status == "VALID"
    assert plan.nodes[0].selected_item.sku == "HOODIE"
    assert plan.nodes[0].catalog_version == "v1"
    value["quotes"][0]["catalogVersion"] = "stale"
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"


def test_distinct_bindings_cannot_double_spend_shared_inventory() -> None:
    value = catalog_payload()
    first = value["candidates"][0]
    second = deepcopy(first)
    second["capabilityId"] = second["capability"]["capabilityId"] = "second"
    second["selectedItem"]["bindingId"] = "b2"
    value["candidates"].append(second)
    quote = deepcopy(value["quotes"][0])
    quote["capabilityId"] = "second"
    quote["selectedItem"] = second["selectedItem"]
    value["quotes"].append(quote)
    value["intent"]["desiredOutputs"].append(
        {"outputId": "out-2", "name": "Hoodie", "attributes": {}}
    )
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"
    for item in value["candidates"]:
        item["resourceRefs"][0]["available"] = 100
    assert solve(SolverInput.model_validate(value)).status == "VALID"


def test_missing_artwork_and_future_resource_evidence_are_not_executable() -> None:
    value = catalog_payload()
    value["candidates"][0]["requiredAssetIds"] = ["logo"]
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"
    value["intent"]["assets"] = [{"assetId": "logo", "checksum": "fixture-logo"}]
    assert solve(SolverInput.model_validate(value)).status == "VALID"
    value["candidates"][0]["resourceRefs"][0]["observedAt"] = "2027-01-01T00:00:00Z"
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"


def test_shared_machine_is_scheduled_across_distinct_capabilities() -> None:
    value = catalog_payload()
    value["intent"]["deadline"] = "2026-09-20T12:00:00Z"
    item = value["candidates"][0]
    item["capability"]["leadTime"] = {"min": 0, "max": 0, "unit": "minutes"}
    item.pop("risk")
    item["transferMinutes"] = 0
    item["resourceRefs"] = [
        {
            "resourceId": "shared-machine",
            "kind": "processing",
            "unit": "units",
            "unitsPerItem": 1,
            "available": 50,
            "periodMinutes": 1440,
            "observedAt": value["now"],
            "sourceReference": "fixture:machine",
        }
    ]
    second = deepcopy(item)
    second["capabilityId"] = second["capability"]["capabilityId"] = "second"
    second["selectedItem"]["bindingId"] = "b2"
    value["candidates"].append(second)
    quote = deepcopy(value["quotes"][0])
    quote["capabilityId"] = "second"
    quote["selectedItem"] = second["selectedItem"]
    value["quotes"].append(quote)
    value["intent"]["desiredOutputs"].append(
        {"outputId": "out-2", "name": "Hoodie", "attributes": {}}
    )
    assert solve(SolverInput.model_validate(value)).status == "UNSAT"
    value["intent"]["deadline"] = "2026-09-21T12:00:00Z"
    plan = solve(SolverInput.model_validate(value))
    assert plan.status == "VALID"
    assert (
        plan.nodes[0].completes_at <= plan.nodes[1].starts_at
        or plan.nodes[1].completes_at <= plan.nodes[0].starts_at
    )
