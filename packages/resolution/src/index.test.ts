import { describe, expect, it } from "vitest";

import {
  CONFLICT_MARGIN_THRESHOLD,
  claimFromRow,
  resolveClaims,
  stableJson,
  type ResolvableClaim,
} from "./index.js";

const now = new Date("2026-09-19T00:00:00.000Z");

function claim(overrides: Partial<ResolvableClaim> = {}): ResolvableClaim {
  return {
    claimId: "claim-a",
    normalizedValue: 400,
    normalizedUnit: "units",
    source: { kind: "email", reference: "supplier-a" },
    ingestedAt: now.toISOString(),
    observedAt: now.toISOString(),
    sourceAuthority: 0.5,
    extractionConfidence: 0.9,
    resolutionStatus: "active",
    ...overrides,
  };
}

describe("shared claim resolver", () => {
  it("reports unknown when no claim is active or every value is null", () => {
    expect(resolveClaims([], now).status).toBe("unknown");
    expect(
      resolveClaims([claim({ resolutionStatus: "superseded" })], now).status,
    ).toBe("unknown");
    expect(resolveClaims([claim({ normalizedValue: null })], now).status).toBe(
      "unknown",
    );
  });

  it("resolves a single claim and explains the winning score", () => {
    const result = resolveClaims([claim()], now);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.winner.claim.claimId).toBe("claim-a");
  });

  it("stays conflicted when two distinct values sit inside the margin", () => {
    const result = resolveClaims(
      [
        claim({ claimId: "a", normalizedValue: 400 }),
        claim({
          claimId: "b",
          normalizedValue: 50,
          source: { kind: "portal", reference: "supplier-b" },
        }),
      ],
      now,
    );
    expect(result.status).toBe("conflicted");
  });

  it("lets a decisively higher-authority claim win outright", () => {
    const result = resolveClaims(
      [
        claim({ claimId: "a", normalizedValue: 400, sourceAuthority: 1 }),
        claim({
          claimId: "b",
          normalizedValue: 50,
          sourceAuthority: 0,
          extractionConfidence: 0,
          source: { kind: "portal", reference: "supplier-b" },
        }),
      ],
      now,
    );
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.winner.claim.normalizedValue).toBe(400);
  });

  // This is the drift the two hand-copied resolvers had. The ROX copy compared
  // values only, so these two agreed; a per-week rate would have been served as
  // if it were per-day. They must conflict.
  it("treats the same number in different units as a conflict, not agreement", () => {
    const result = resolveClaims(
      [
        claim({ claimId: "a", normalizedValue: 40, normalizedUnit: "units" }),
        claim({
          claimId: "b",
          normalizedValue: 40,
          normalizedUnit: "units/week",
          source: { kind: "portal", reference: "supplier-b" },
        }),
      ],
      now,
    );
    expect(result.status).toBe("conflicted");
  });

  it("does not let a different unit count as corroboration", () => {
    const scored = resolveClaims(
      [
        claim({ claimId: "a", normalizedValue: 40, normalizedUnit: "units" }),
        claim({
          claimId: "b",
          normalizedValue: 40,
          normalizedUnit: "units/week",
          source: { kind: "portal", reference: "supplier-b" },
        }),
      ],
      now,
    );
    if (scored.status !== "conflicted") throw new Error("expected conflict");
    for (const entry of scored.allScored) {
      // corroboration weight is 0.1; any bonus would show up here
      expect(entry.score).toBeLessThan(
        0.35 * 0.5 + 0.3 * 1 + 0.25 * 0.9 + 0.1 * 0.0001,
      );
    }
  });

  it("prefers the fresher observation when authority and confidence tie", () => {
    const result = resolveClaims(
      [
        claim({
          claimId: "stale",
          normalizedValue: 400,
          observedAt: "2026-08-01T00:00:00.000Z",
        }),
        claim({
          claimId: "fresh",
          normalizedValue: 200,
          observedAt: now.toISOString(),
          source: { kind: "portal", reference: "supplier-b" },
        }),
      ],
      now,
    );
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.winner.claim.claimId).toBe("fresh");
  });

  it("keeps the conflict margin at the documented value", () => {
    expect(CONFLICT_MARGIN_THRESHOLD).toBe(0.08);
  });
});

describe("stableJson", () => {
  it("orders object keys so equal values compare equal", () => {
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
  });

  it("drops undefined members and renders missing values as null", () => {
    expect(stableJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(stableJson(undefined)).toBe("null");
  });
});

describe("claimFromRow", () => {
  it("coerces node-postgres string numerics and Date columns", () => {
    const adapted = claimFromRow({
      claim_id: "row-a",
      normalized_value: 12,
      normalized_unit: null,
      source_kind: "shopify",
      source_reference: "gid://shopify/InventoryItem/1",
      observed_at: new Date("2026-09-18T00:00:00.000Z"),
      ingested_at: new Date("2026-09-19T00:00:00.000Z"),
      source_authority: "0.90",
      extraction_confidence: "1.00",
      resolution_status: "active",
    });
    expect(adapted.sourceAuthority).toBe(0.9);
    expect(adapted.extractionConfidence).toBe(1);
    expect(adapted.normalizedUnit).toBeUndefined();
    expect(adapted.observedAt).toBe("2026-09-18T00:00:00.000Z");
  });

  it("resolves adapted rows identically to camelCase claims", () => {
    const row = claimFromRow({
      claim_id: "row-a",
      normalized_value: 500,
      normalized_unit: "units",
      source_kind: "shopify",
      source_reference: "ref-a",
      ingested_at: now.toISOString(),
      source_authority: "0.5",
      extraction_confidence: "0.9",
      resolution_status: "active",
    });
    const direct = resolveClaims([claim({ normalizedValue: 500 })], now);
    const adapted = resolveClaims([row], now);
    if (direct.status !== "resolved" || adapted.status !== "resolved")
      throw new Error("expected both to resolve");
    expect(adapted.winner.score).toBeCloseTo(direct.winner.score, 12);
  });
});
