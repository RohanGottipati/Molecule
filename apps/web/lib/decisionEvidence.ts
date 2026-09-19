import type { CanonicalClaim, MerchantTwinSummary } from "@molecule/contracts";

export function evidenceGroups(claims: CanonicalClaim[], filter = "all") {
  const fields = new Map<string, CanonicalClaim[]>();
  for (const claim of claims) {
    const key = JSON.stringify([claim.merchantId, claim.field]);
    const group = fields.get(key) ?? [];
    group.push(claim);
    fields.set(key, group);
  }
  return [...fields.entries()]
    .filter(([, group]) =>
      group.some(
        (claim) => filter === "all" || claim.resolutionStatus === filter,
      ),
    )
    .map(([key, group]) => ({
      key,
      field: group[0]!.field,
      claims: group,
      conflicted: group.some(
        (claim) => claim.resolutionStatus === "conflicted",
      ),
    }))
    .sort(
      (a, b) =>
        Number(b.conflicted) - Number(a.conflicted) ||
        a.field.localeCompare(b.field),
    );
}

export function merchantSelection(
  merchants: MerchantTwinSummary[],
  query: string,
  selectedId: string | null,
) {
  const search = query.trim().toLowerCase();
  const filtered = merchants.filter((merchant) =>
    `${merchant.name} ${merchant.merchantId} ${merchant.capabilities.map((item) => item.capability.name).join(" ")}`
      .toLowerCase()
      .includes(search),
  );
  return {
    filtered,
    selected:
      filtered.find((merchant) => merchant.merchantId === selectedId) ??
      filtered[0],
  };
}
