import { describe, expect, it } from "vitest";

import { normalizeValue, toCanonicalClaim } from "./ingestion.js";
import { resolveClaims } from "./resolution.js";

describe("deterministic normalization boundaries", () => {
  it.each([
    ["price", "USD 10"],
    ["price", "10 per item"],
    ["price", "1,23"],
    ["price", -1],
    ["capacity", "10 hours"],
    ["lead_time_hours", "10 units"],
    ["inventory", ""],
    ["capacity", Infinity],
  ])(
    "quarantines invalid values and incompatible units: %s / %s",
    (field, value) => {
      expect(normalizeValue(String(field), value).ok).toBe(false);
    },
  );
  it("uses stable claim identity independent of object key order and ingest time", () => {
    const base = {
      merchantId: "sample",
      field: "attributes",
      sourceKind: "document" as const,
      sourceReference: "doc:one",
      sourceAuthority: 1,
      extractionConfidence: 1,
    };
    const first = toCanonicalClaim(
      { ...base, rawValue: { color: "black", material: "cotton" } },
      new Date("2026-09-19T00:00:00Z"),
    );
    const second = toCanonicalClaim(
      { ...base, rawValue: { material: "cotton", color: "black" } },
      new Date("2026-09-20T00:00:00Z"),
    );
    expect(
      first.ok && second.ok && first.claim.claimId === second.claim.claimId,
    ).toBe(true);
  });
  it("quarantines malformed source metadata", () => {
    expect(
      toCanonicalClaim({
        merchantId: "sample",
        field: "price",
        rawValue: 10,
        sourceKind: "api",
        sourceReference: "api:one",
        sourceAuthority: 1,
        extractionConfidence: 1,
        observedAt: "not-a-date",
      }).ok,
    ).toBe(false);
  });
  it("keeps canonical facts with missing normalized values unknown", () => {
    const parsed = toCanonicalClaim({
      merchantId: "sample",
      field: "price",
      rawValue: 10,
      sourceKind: "api",
      sourceReference: "api:missing-value",
      sourceAuthority: 1,
      extractionConfidence: 1,
    });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(resolveClaims([{ ...parsed.claim, normalizedValue: null }])).toEqual(
      { status: "unknown" },
    );
  });
});
