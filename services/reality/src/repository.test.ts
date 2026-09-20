import { describe, expect, it } from "vitest";
import type { CanonicalClaim } from "@molecule/contracts";
import { resolveMerchantClaims } from "./repository.js";

const now = new Date("2026-09-19T12:00:00Z");
function claim(overrides: Partial<CanonicalClaim> = {}): CanonicalClaim {
  return {
    claimId: "newest",
    merchantId: "merchant",
    field: "inventory",
    normalizedValue: 0,
    source: { kind: "shopify", reference: "inventory:one" },
    observedAt: now.toISOString(),
    ingestedAt: now.toISOString(),
    sourceAuthority: 1,
    extractionConfidence: 1,
    resolutionStatus: "active",
    ...overrides,
  };
}

describe("merchant source streams", () => {
  it("preserves the winning capacity unit for downstream rate comparisons", () => {
    expect(
      resolveMerchantClaims(
        [
          claim({
            field: "capacity",
            normalizedValue: 80,
            normalizedUnit: "units/day",
          }),
        ],
        now,
      )[0]?.fact,
    ).toMatchObject({
      status: "resolved",
      value: 80,
      normalizedUnit: "units/day",
    });
  });
  it.each(["active", "superseded"] as const)(
    "never resurrects an older %s observation, including a delayed webhook",
    (resolutionStatus) => {
      const result = resolveMerchantClaims(
        [
          claim({
            claimId: "older",
            normalizedValue: 20,
            resolutionStatus,
            observedAt: "2026-09-19T11:00:00Z",
          }),
          claim(),
          claim({
            claimId: "delayed",
            normalizedValue: 10,
            resolutionStatus,
            observedAt: "2026-09-19T11:30:00Z",
            ingestedAt: "2026-09-19T12:01:00Z",
          }),
        ],
        now,
      )[0]!;
      expect(result.fact).toMatchObject({
        status: "resolved",
        value: 0,
        winningClaimId: "newest",
      });
    },
  );

  it("keeps simultaneous conflicting observations unresolved", () => {
    expect(
      resolveMerchantClaims(
        [claim(), claim({ claimId: "tie", normalizedValue: 10 })],
        now,
      )[0]?.fact.status,
    ).toBe("conflicted");
  });

  it("reconsiders different sources without discarding their disagreement", () => {
    expect(
      resolveMerchantClaims(
        [
          claim(),
          claim({
            claimId: "other",
            normalizedValue: 10,
            source: { kind: "api", reference: "inventory:one" },
            resolutionStatus: "superseded",
          }),
        ],
        now,
      )[0]?.fact.status,
    ).toBe("conflicted");
  });

  it("does not replace a newer unknown observation with older known stock", () => {
    expect(
      resolveMerchantClaims(
        [
          claim({ normalizedValue: null, resolutionStatus: "unknown" }),
          claim({
            claimId: "older",
            normalizedValue: 20,
            resolutionStatus: "superseded",
            observedAt: "2026-09-19T11:00:00Z",
          }),
        ],
        now,
      )[0]?.fact.status,
    ).toBe("unknown");
  });

  it("does not let quarantined input supersede the last valid observation", () => {
    expect(
      resolveMerchantClaims(
        [
          claim(),
          claim({
            claimId: "invalid",
            normalizedValue: "invalid",
            resolutionStatus: "quarantined",
            observedAt: "2026-09-19T12:01:00Z",
          }),
        ],
        now,
      )[0]?.fact,
    ).toMatchObject({ status: "resolved", value: 0 });
  });
});
