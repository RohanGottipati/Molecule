import {
  CanonicalClaimSchema,
  MerchantTwinSummarySchema,
} from "@molecule/contracts";
import { describe, expect, it } from "vitest";
import { evidenceGroups, merchantSelection } from "./decisionEvidence";

const claim = CanonicalClaimSchema.parse({
  claimId: "capacity-1",
  merchantId: "supplier-a",
  field: "capacity.available",
  normalizedValue: 20,
  source: { kind: "api", reference: "warehouse" },
  ingestedAt: "2026-09-19T10:00:00Z",
  sourceAuthority: 0.9,
  extractionConfidence: 1,
  resolutionStatus: "conflicted",
});

describe("source comparisons", () => {
  it("retains other source values when filtering a conflicting field", () => {
    const history = {
      ...claim,
      claimId: "capacity-old",
      normalizedValue: 40,
      resolutionStatus: "superseded" as const,
    };
    const other = {
      ...claim,
      claimId: "price",
      field: "pricing.unitPrice",
      resolutionStatus: "active" as const,
    };
    const result = evidenceGroups([history, other, claim], "conflicted");
    expect(result).toHaveLength(1);
    expect(result[0]?.claims).toEqual([history, claim]);
    expect(evidenceGroups([other], "unknown")).toEqual([]);
  });
  it("never merges equal field names across merchants or invents conflicts", () => {
    const other = {
      ...claim,
      merchantId: "supplier-b",
      resolutionStatus: "active" as const,
    };
    expect(evidenceGroups([claim, other])).toHaveLength(2);
    expect(evidenceGroups([other])[0]?.conflicted).toBe(false);
  });
});

describe("merchant search selection", () => {
  const merchants = ["Alpha", "Beta"].map((name) =>
    MerchantTwinSummarySchema.parse({
      merchantId: name,
      name,
      status: "unknown",
      capabilities: [],
      claims: [],
      memories: [],
      policies: [],
      documents: [],
    }),
  );
  it("shows detail only for a visible match and restores explicit selection after clearing", () => {
    expect(merchantSelection(merchants, " beta ", "Alpha").selected?.name).toBe(
      "Beta",
    );
    expect(
      merchantSelection(merchants, "missing", "Alpha").selected,
    ).toBeUndefined();
    expect(merchantSelection(merchants, "", "Alpha").selected?.name).toBe(
      "Alpha",
    );
  });
});
