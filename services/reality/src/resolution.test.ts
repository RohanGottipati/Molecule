import { describe, expect, it } from "vitest";

import type { CanonicalClaim } from "@molecule/contracts";

import { explainResolution, resolveClaims } from "./resolution.js";

function claim(overrides: Partial<CanonicalClaim>): CanonicalClaim {
  return {
    claimId: "claim-default",
    merchantId: "m-customizeco",
    field: "capacity_per_day",
    normalizedValue: 0,
    source: { kind: "note", reference: "test" },
    ingestedAt: new Date().toISOString(),
    sourceAuthority: 0.5,
    extractionConfidence: 0.5,
    resolutionStatus: "active",
    ...overrides,
  };
}

const NOW = new Date("2026-09-19T00:00:00.000Z");

describe("resolveClaims", () => {
  it("resolves the playbook's 100/50/20 case to the fresh 20/day note", () => {
    const claims: CanonicalClaim[] = [
      claim({
        claimId: "website",
        normalizedValue: 100,
        source: { kind: "shopify", reference: "product-description" },
        observedAt: new Date(NOW.getTime() - 30 * 86400_000).toISOString(),
        sourceAuthority: 0.5,
        extractionConfidence: 0.6,
      }),
      claim({
        claimId: "pdf",
        normalizedValue: 50,
        source: { kind: "document", reference: "pricing-sheet.pdf" },
        observedAt: new Date(NOW.getTime() - 10 * 86400_000).toISOString(),
        sourceAuthority: 0.6,
        extractionConfidence: 0.7,
      }),
      claim({
        claimId: "note",
        normalizedValue: 20,
        source: { kind: "note", reference: "machine-2-down" },
        observedAt: new Date(NOW.getTime() - 1 * 86400_000).toISOString(),
        sourceAuthority: 0.9,
        extractionConfidence: 0.95,
      }),
    ];

    const result = resolveClaims(claims, NOW);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.winner.claim.claimId).toBe("note");
      expect(result.winner.claim.normalizedValue).toBe(20);
    }
    expect(explainResolution(result)).toMatch(/Resolved to 20/);
  });

  it("stays conflicted when two equally recent, equally authoritative claims disagree", () => {
    const claims: CanonicalClaim[] = [
      claim({
        claimId: "a",
        normalizedValue: 40,
        observedAt: NOW.toISOString(),
        sourceAuthority: 0.8,
        extractionConfidence: 0.8,
      }),
      claim({
        claimId: "b",
        normalizedValue: 60,
        observedAt: NOW.toISOString(),
        sourceAuthority: 0.8,
        extractionConfidence: 0.8,
      }),
    ];

    const result = resolveClaims(claims, NOW);
    expect(result.status).toBe("conflicted");
    expect(explainResolution(result)).toMatch(/Conflicted/);
  });

  it("reports unknown when there are no active claims", () => {
    const result = resolveClaims([], NOW);
    expect(result.status).toBe("unknown");
  });

  it("does not corroborate identical numeric values with incompatible units", () => {
    expect(
      resolveClaims(
        [
          claim({
            claimId: "days",
            normalizedValue: 10,
            normalizedUnit: "days",
          }),
          claim({
            claimId: "hours",
            normalizedValue: 10,
            normalizedUnit: "hours",
          }),
        ],
        NOW,
      ).status,
    ).toBe("conflicted");
  });

  it("ignores quarantined and superseded claims when resolving", () => {
    const claims: CanonicalClaim[] = [
      claim({
        claimId: "quarantined",
        normalizedValue: "garbage",
        resolutionStatus: "quarantined",
      }),
      claim({
        claimId: "good",
        normalizedValue: 20,
        observedAt: NOW.toISOString(),
        sourceAuthority: 0.9,
        extractionConfidence: 0.9,
      }),
    ];

    const result = resolveClaims(claims, NOW);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.winner.claim.claimId).toBe("good");
    }
  });
});
