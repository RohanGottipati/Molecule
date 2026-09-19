import type {
  CanonicalClaim,
  MerchantCapability,
  ProductIntent,
} from "@molecule/contracts";
export { kitIntent } from "./kit.js";

/** The demo world's forced capacity conflict, mirroring sql/004_seed.sql. */
export const CUSTOMIZECO_CAPACITY_CLAIMS: CanonicalClaim[] = [
  {
    claimId: "claim-cust-capacity-website",
    merchantId: "m-customizeco",
    field: "capacity_per_day",
    normalizedValue: 100,
    normalizedUnit: "units",
    source: { kind: "shopify", reference: "shopify:product-description" },
    observedAt: "2026-08-20T00:00:00.000Z",
    ingestedAt: "2026-09-18T00:00:00.000Z",
    sourceAuthority: 0.5,
    extractionConfidence: 0.6,
    resolutionStatus: "active",
    evidenceText:
      'Shopify product page lists "up to 100 units/day" in marketing copy',
  },
  {
    claimId: "claim-cust-capacity-pdf",
    merchantId: "m-customizeco",
    field: "capacity_per_day",
    normalizedValue: 50,
    normalizedUnit: "units",
    source: { kind: "document", reference: "doc:pricing-sheet.pdf" },
    observedAt: "2026-09-09T00:00:00.000Z",
    ingestedAt: "2026-09-18T00:00:00.000Z",
    sourceAuthority: 0.6,
    extractionConfidence: 0.7,
    resolutionStatus: "active",
    evidenceText: "Pricing sheet PDF states standard capacity of 50 units/day",
  },
  {
    claimId: "claim-cust-capacity-note",
    merchantId: "m-customizeco",
    field: "capacity_per_day",
    normalizedValue: 20,
    normalizedUnit: "units",
    source: { kind: "note", reference: "note:machine-2-down" },
    observedAt: "2026-09-18T00:00:00.000Z",
    ingestedAt: "2026-09-18T00:00:00.000Z",
    sourceAuthority: 0.9,
    extractionConfidence: 0.95,
    resolutionStatus: "active",
    evidenceText:
      'Merchant-submitted note: "machine #2 is down, capacity is 20/day until fixed"',
  },
];

export const BASEGOODS_CAPABILITY: MerchantCapability = {
  capabilityId: "cap-basegoods-hoodie",
  merchantId: "m-basegoods",
  kind: "SUPPLY",
  name: "Black cotton hoodie",
  description: "Black cotton hoodies, sizes S-XL",
  accepts: [],
  produces: [
    {
      kind: "garment",
      name: "cotton_hoodie",
      attributes: { color: "black", material: "cotton" },
    },
  ],
  quantity: { min: 1, max: 500, unit: "unit" },
  pricing: { currency: "CAD", unitPrice: 18, setupFee: 0 },
  leadTime: { min: 4, max: 24, unit: "hours" },
  capacity: { available: 500, maximum: 500, period: "week" },
  hardRules: [],
  softRules: [],
  sourceClaimIds: [],
};

export const SAMPLE_PRODUCT_INTENT: ProductIntent = {
  intentId: "9e0c7b1a-0000-4000-8000-000000000001",
  version: 1,
  quantity: 55,
  deadline: "2026-09-22T00:00:00.000Z",
  currency: "CAD",
  budgetMax: 1200,
  desiredOutputs: [
    {
      outputId: "out-1",
      name: "Embroidered hoodie",
      quantity: 55,
      attributes: { color: "black", material: "cotton" },
    },
  ],
  transformations: [
    {
      transformationId: "t-embroidery",
      kind: "embroidery",
      description: "Logo embroidery on the front chest",
      inputRefs: ["out-1"],
      outputRefs: ["out-1"],
    },
  ],
  hardConstraints: [
    {
      constraintId: "c-material",
      field: "material",
      operator: "neq",
      value: "polyester",
    },
  ],
  softPreferences: [],
  assets: [],
  ambiguityFlags: [],
};
