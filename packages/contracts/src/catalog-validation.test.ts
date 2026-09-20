import { describe, expect, it } from "vitest";
import { CatalogRecordSchema, validateCatalogJsonl } from "./index.js";

const evidence = {
  sourceReference: "fixture:test",
  observedAt: "2026-09-19T00:00:00Z",
  synthetic: true,
};
const merchant = {
  recordType: "merchant",
  id: "merchant",
  name: "Test",
  evidence,
};
function delivery(
  records: unknown[],
  counts = {
    merchant: 1,
    product: 0,
    variant: 0,
    family: 0,
    resource: 0,
    fact: 0,
    binding: 0,
    recipe: 0,
  },
) {
  return [
    {
      recordType: "manifest",
      schemaVersion: 1,
      catalogVersion: "v1",
      createdAt: evidence.observedAt,
      categories: ["Apparel"],
      complete: true,
      recordCounts: counts,
    },
    ...records,
  ]
    .map((x) => JSON.stringify(x))
    .join("\n");
}
describe("catalog handoff", () => {
  it("validates reproducibly and detects incomplete snapshots", () => {
    expect(validateCatalogJsonl(delivery([merchant])).errors).toEqual([]);
    expect(validateCatalogJsonl(delivery([])).errors.join()).toContain(
      "COUNT_MISMATCH",
    );
    expect(
      validateCatalogJsonl(delivery([merchant, merchant])).errors.join(),
    ).toContain("DUPLICATE_ID");
  });
  it("rejects dangling references with line-specific diagnostics", () => {
    const result = validateCatalogJsonl(
      delivery([
        merchant,
        {
          recordType: "product",
          id: "p",
          merchantId: "absent",
          name: "Shirt",
          category: "Apparel",
          itemKind: "physical",
          evidence,
        },
      ]),
    );
    expect(result.errors.join()).toContain("UNKNOWN_REFERENCE p.merchantId");
    expect(
      validateCatalogJsonl(delivery([merchant]) + '\n{"broken"').errors.join(),
    ).toContain("line 3");
  });
  it("preserves unresolved facts and rejects implicit duration/pricing assumptions", () => {
    const fact = {
      recordType: "fact",
      id: "f",
      merchantId: "merchant",
      subjectId: "b",
      field: "timing",
      assertion: { status: "unknown", reason: "Calendar missing" },
      evidence,
    };
    expect(CatalogRecordSchema.parse(fact)).toMatchObject({
      assertion: { status: "unknown" },
    });
    expect(
      CatalogRecordSchema.safeParse({
        ...fact,
        assertion: { status: "known", value: { days: 2 } },
      }).success,
    ).toBe(false);
    expect(
      CatalogRecordSchema.safeParse({
        ...fact,
        field: "pricing",
        assertion: {
          status: "known",
          value: { currency: "CAD", unitPrice: 2 },
        },
      }).success,
    ).toBe(false);
  });
  it("requires explicit processing periods and exact Shopify inventory locations", () => {
    const resource = {
      recordType: "resource",
      id: "r",
      merchantId: "merchant",
      kind: "processing",
      unit: "units",
      availability: { status: "known", value: 25 },
      evidence,
    };
    expect(CatalogRecordSchema.safeParse(resource).success).toBe(false);
    expect(
      CatalogRecordSchema.safeParse({ ...resource, periodMinutes: 1440 })
        .success,
    ).toBe(true);
    expect(
      CatalogRecordSchema.safeParse({
        ...resource,
        periodMinutes: 1440,
        inventoryItemGid: "gid://shopify/InventoryItem/1",
      }).success,
    ).toBe(false);
  });
});
