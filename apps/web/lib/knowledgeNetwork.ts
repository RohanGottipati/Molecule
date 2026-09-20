import type { CanonicalClaim, MerchantTwinSummary } from "@molecule/contracts";
import { evidenceGroups } from "./decisionEvidence";
import { humanize } from "./workspace";
export type KnowledgeSelection = {
  title: string;
  subtitle: string;
  kind: "Source" | "Fact" | "Supplier" | "Capability";
  merchantId?: string;
  status: string;
  warning: boolean;
  claims: CanonicalClaim[];
};
export type Point = KnowledgeSelection & { id: string; x: number; y: number };

export function buildKnowledgeNetwork(
  merchants: MerchantTwinSummary[],
  filter = "all",
) {
  const nodes: Point[] = [];
  const links: [number, number][] = [];
  const sources = new Map<
    string,
    { claims: CanonicalClaim[]; targets: number[] }
  >();
  merchants.forEach((merchant, index) => {
    const groups = evidenceGroups(merchant.claims, filter);
    if (filter !== "all" && !groups.length) return;
    const angle = index * 2.399963;
    const radius = Math.sqrt(index) * 460;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const supplier = nodes.length;
    nodes.push({
      id: `supplier:${merchant.merchantId}`,
      x,
      y,
      title: merchant.name,
      subtitle: `${merchant.capabilities.length} capabilities · ${merchant.claims.length} claims`,
      kind: "Supplier",
      merchantId: merchant.merchantId,
      status: humanize(merchant.status),
      warning: merchant.status === "offline",
      claims: merchant.claims,
    });
    groups.forEach((group, i) => {
      const theta = (i / groups.length) * Math.PI * 2;
      const spread = 115 + Math.sqrt(groups.length) * 12;
      const fact = nodes.length;
      nodes.push({
        id: `fact:${group.key}`,
        x: x + Math.cos(theta) * spread,
        y: y + Math.sin(theta) * spread,
        title: humanize(group.field),
        subtitle: merchant.name,
        kind: "Fact",
        merchantId: merchant.merchantId,
        status: group.conflicted ? "Conflicted" : "Recorded",
        warning: group.conflicted,
        claims: group.claims,
      });
      links.push([fact, supplier]);
      for (const claim of group.claims) {
        const key = JSON.stringify([claim.source.kind, claim.source.reference]);
        const source = sources.get(key) ?? { claims: [], targets: [] };
        source.claims.push(claim);
        if (!source.targets.includes(fact)) source.targets.push(fact);
        sources.set(key, source);
      }
    });
    merchant.capabilities.forEach((candidate, i) => {
      const capability = candidate.capability;
      const theta = i * 2.399963 + angle;
      const claims = merchant.claims.filter((c) =>
        capability.sourceClaimIds.includes(c.claimId),
      );
      if (
        filter !== "all" &&
        !claims.some((c) => c.resolutionStatus === filter)
      )
        return;
      const capabilityIndex = nodes.length;
      nodes.push({
        id: `capability:${merchant.merchantId}:${candidate.capabilityId}`,
        x: x + Math.cos(theta) * 285,
        y: y + Math.sin(theta) * 285,
        title: capability.name,
        subtitle: `${merchant.name} · ${humanize(capability.kind)} · ${capability.description}`,
        kind: "Capability",
        merchantId: merchant.merchantId,
        status: candidate.blockedReasons.length ? "Restricted" : "Listed",
        warning: candidate.blockedReasons.length > 0,
        claims,
      });
      links.push([capabilityIndex, supplier]);
      for (let j = supplier + 1; j < capabilityIndex; j++) {
        const n = nodes[j]!;
        if (
          n.kind === "Fact" &&
          n.claims.some((c) => capability.sourceClaimIds.includes(c.claimId))
        )
          links.push([j, capabilityIndex]);
      }
    });
  });
  [...sources.entries()].forEach(([id, source], index) => {
    const targets = source.targets.map((i) => nodes[i]!);
    const angle = index * 2.399963;
    const x =
      targets.reduce((sum, n) => sum + n.x, 0) / targets.length +
      Math.cos(angle) * 280;
    const y =
      targets.reduce((sum, n) => sum + n.y, 0) / targets.length +
      Math.sin(angle) * 280;
    const nodeIndex = nodes.length;
    const first = source.claims[0]!;
    nodes.push({
      id: `source:${id}`,
      x,
      y,
      title: first.source.reference.split("/").at(-1) || first.source.reference,
      subtitle: `${humanize(first.source.kind)} · ${first.source.reference}`,
      kind: "Source",
      status: "Recorded",
      warning: false,
      claims: source.claims,
    });
    for (const target of source.targets) links.push([nodeIndex, target]);
  });
  return {
    nodes,
    links,
    suppliers: nodes.filter((n) => n.kind === "Supplier").length,
    facts: nodes.filter((n) => n.kind === "Fact").length,
    sources: sources.size,
    capabilities: nodes.filter((n) => n.kind === "Capability").length,
  };
}
