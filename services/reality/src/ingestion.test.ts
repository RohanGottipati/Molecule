import { describe, expect, it } from "vitest";

import { normalizeValue, toCanonicalClaim } from "./ingestion.js";

describe("normalizeValue", () => {
  it("parses a clean number", () => {
    expect(normalizeValue("capacity_per_day", 20)).toEqual({
      ok: true,
      value: 20,
      unit: "units",
    });
  });

  it("parses a numeric string with currency formatting", () => {
    const result = normalizeValue("price", "$1,250.50");
    expect(result).toEqual({ ok: true, value: 1250.5 });
  });

  it("quarantines a non-numeric value for a numeric field", () => {
    const result = normalizeValue("capacity_per_day", "about a lot, ask us");
    expect(result.ok).toBe(false);
  });

  it("passes through non-numeric fields untouched", () => {
    const result = normalizeValue("material", "cotton");
    expect(result).toEqual({ ok: true, value: "cotton" });
  });
});

describe("toCanonicalClaim", () => {
  it("builds a claim from a well-formed input", () => {
    const result = toCanonicalClaim({
      merchantId: "m-customizeco",
      field: "capacity_per_day",
      rawValue: "20",
      sourceKind: "note",
      sourceReference: "machine-2-down",
      sourceAuthority: 0.9,
      extractionConfidence: 0.95,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim.normalizedValue).toBe(20);
      expect(result.claim.resolutionStatus).toBe("active");
    }
  });

  it("quarantines instead of throwing on a malformed CSV row", () => {
    const result = toCanonicalClaim({
      merchantId: "m-customizeco",
      field: "capacity_per_day",
      rawValue: "N/A - call for quote",
      sourceKind: "csv",
      sourceReference: "row-14",
      sourceAuthority: 0.3,
      extractionConfidence: 0.2,
    });
    expect(result.ok).toBe(false);
  });
});
