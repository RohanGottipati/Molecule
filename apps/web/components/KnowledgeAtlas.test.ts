import { describe, expect, it } from "vitest";
import {
  CanonicalClaimSchema,
  MerchantTwinSummarySchema,
} from "@molecule/contracts";
import { buildKnowledgeNetwork } from "../lib/knowledgeNetwork";

const claim = CanonicalClaimSchema.parse({
  claimId: "a",
  merchantId: "a",
  field: "capacity",
  normalizedValue: 10,
  source: { kind: "csv", reference: "shared.csv" },
  ingestedAt: "2026-09-20T00:00:00Z",
  sourceAuthority: 1,
  extractionConfidence: 1,
  resolutionStatus: "conflicted",
});
const supplier = (id: string, claims = [claim]) =>
  MerchantTwinSummarySchema.parse({
    merchantId: id,
    name: id,
    status: "unknown",
    claims,
    capabilities: [],
    memories: [],
    policies: [],
    documents: [],
  });

describe("whole knowledge network", () => {
  it("shares identical source records without merging supplier facts or inventing links", () => {
    const graph = buildKnowledgeNetwork([
      supplier("a"),
      supplier("b", [{ ...claim, claimId: "b", merchantId: "b" }]),
      supplier("empty", []),
    ]);
    expect(graph.suppliers).toBe(3);
    expect(graph.facts).toBe(2);
    expect(graph.sources).toBe(1);
    expect(graph.links).toHaveLength(4);
    const empty = graph.nodes.findIndex((n) => n.id === "supplier:empty");
    expect(graph.links.some(([a, b]) => a === empty || b === empty)).toBe(
      false,
    );
    expect(
      graph.nodes
        .find((n) => n.kind === "Source")
        ?.claims.map((c) => c.claimId),
    ).toEqual(["a", "b"]);
  });
  it("retains conflicting fact history when filtering and never treats absence as evidence", () => {
    const history = {
      ...claim,
      claimId: "old",
      resolutionStatus: "superseded" as const,
      normalizedValue: 20,
    };
    const graph = buildKnowledgeNetwork(
      [supplier("a", [claim, history]), supplier("empty", [])],
      "conflicted",
    );
    expect(graph.suppliers).toBe(1);
    expect(graph.nodes.find((n) => n.kind === "Fact")?.claims).toHaveLength(2);
    expect(graph.nodes.find((n) => n.kind === "Fact")?.warning).toBe(true);
    expect(buildKnowledgeNetwork([supplier("a")], "active").nodes).toHaveLength(
      0,
    );
  });
});
