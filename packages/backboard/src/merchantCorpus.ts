import type { UploadMerchantDocumentInput } from "./types.js";

export type MerchantCorpusDocumentInput = Omit<
  UploadMerchantDocumentInput,
  "merchantId" | "assistantId"
>;

/**
 * Small, high-signal B2 demo fixtures for a merchant twin's RAG corpus:
 * service catalog, pricing policy, equipment constraints, materials policy,
 * shipping rules, and one intentionally stale document. The stale doc
 * restates the equipment constraint as it was before machine #2 went down,
 * so retrieval can find it while a live capacity tool must still win.
 */
export function buildDemoMerchantCorpus(
  now: string = new Date().toISOString(),
): MerchantCorpusDocumentInput[] {
  return [
    {
      fileName: "service-catalog.md",
      mimeType: "text/markdown",
      category: "service_catalog",
      version: 1,
      sourceTimestamp: now,
      content: [
        "Acme Embroidery Service Catalog",
        "- Flat embroidery on garments and caps.",
        "- 3D puff embroidery for logos and patches.",
        "- Patch creation and application.",
        "- Standard turnaround: 5 business days.",
        "- Rush turnaround: 2 business days for orders under 40 units.",
      ].join("\n"),
    },
    {
      fileName: "pricing-policy.md",
      mimeType: "text/markdown",
      category: "pricing_policy",
      version: 1,
      sourceTimestamp: now,
      content: [
        "Acme Embroidery Pricing Policy",
        "- One-time digitizing fee: $35 per unique design.",
        "- Rush surcharge: 25% of order subtotal for turnaround under 3 business days.",
        "- Volume discount: 10% off orders of 100 units or more of the same design.",
      ].join("\n"),
    },
    {
      fileName: "equipment-constraints.md",
      mimeType: "text/markdown",
      category: "equipment_constraints",
      version: 2,
      sourceTimestamp: now,
      content: [
        "Acme Embroidery Equipment Constraints (current)",
        "- Machines #1, #3, and #4 are active 6-head Tajima units.",
        "- Machine #2 is currently down for maintenance until further notice.",
        "- Rush capacity is reduced while machine #2 is offline; always confirm with get_capacity.",
      ].join("\n"),
    },
    {
      fileName: "materials-policy.md",
      mimeType: "text/markdown",
      category: "materials_policy",
      version: 1,
      sourceTimestamp: now,
      content: [
        "Acme Embroidery Materials Policy",
        "- Only pre-shrunk cotton and poly-blend fabrics are accepted for puff embroidery.",
        "- Customer-supplied garments must be pre-washed before drop-off.",
        "- Stabilizer backing is required on all knit fabrics.",
      ].join("\n"),
    },
    {
      fileName: "shipping-rules.md",
      mimeType: "text/markdown",
      category: "shipping_rules",
      version: 1,
      sourceTimestamp: now,
      content: [
        "Acme Embroidery Shipping Rules",
        "- Standard orders ship via ground within 2 business days of completion.",
        "- Rush orders ship same-day if completed before 2pm local time.",
        "- No Saturday shipping.",
      ].join("\n"),
    },
    {
      fileName: "equipment-constraints-2025-01.md",
      mimeType: "text/markdown",
      category: "equipment_constraints",
      version: 1,
      sourceTimestamp: "2025-01-15T00:00:00.000Z",
      stale: true,
      content: [
        "Acme Embroidery Equipment Constraints (superseded 2025-01)",
        "- All 6 embroidery machines (#1-#6) are operational.",
        "- Full rush capacity is 100 units/day across the shop.",
      ].join("\n"),
    },
  ];
}
