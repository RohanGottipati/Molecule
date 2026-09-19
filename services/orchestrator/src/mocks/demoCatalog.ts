import type {
  CandidateCapability,
  MerchantCapability,
} from "@molecule/contracts";

type CapabilityPort = MerchantCapability["produces"][number];

function port(
  product: string,
  attributes: Record<string, unknown> = {},
): CapabilityPort {
  return {
    kind: "product",
    name: product,
    unit: "units",
    attributes: { product, ...attributes },
  };
}

export function demoCandidates(): CandidateCapability[] {
  const hoodie = port("hoodie", {
    material: "cotton",
    color: "black",
    quality: "premium",
  });
  const bottle = port("bottle", {
    material: "stainless steel",
    color: "black",
    quality: "premium",
  });
  const snacks = port("snacks", {
    material: "plant-based",
    diet: "vegan",
    quality: "premium",
  });
  const embroidered = port("hoodie", {
    ...hoodie.attributes,
    operation: "embroidery",
    decoration: "embroidery",
  });
  const engraved = port("bottle", {
    ...bottle.attributes,
    operation: "engraving",
    decoration: "engraving",
  });
  const kit = port("kit", {
    material: "recycled cardboard",
    packaging: "individual",
  });
  const specs: {
    id: string;
    merchant: string;
    kind: MerchantCapability["kind"];
    name: string;
    price: number;
    hours: number;
    capacity: number;
    accepts: CapabilityPort[];
    produces: CapabilityPort[];
  }[] = [
    {
      id: "supply-base",
      merchant: "base-goods",
      kind: "SUPPLY",
      name: "Premium black hoodie",
      price: 12,
      hours: 8,
      capacity: 1000,
      accepts: [],
      produces: [hoodie],
    },
    {
      id: "supply-backup",
      merchant: "base-goods-2",
      kind: "SUPPLY",
      name: "Backup black hoodie",
      price: 12,
      hours: 8,
      capacity: 1000,
      accepts: [],
      produces: [hoodie],
    },
    {
      id: "supply-bottle",
      merchant: "base-goods",
      kind: "SUPPLY",
      name: "Black steel bottle",
      price: 5,
      hours: 8,
      capacity: 1000,
      accepts: [],
      produces: [bottle],
    },
    {
      id: "supply-snacks",
      merchant: "snack-box",
      kind: "SUPPLY",
      name: "Vegan snacks",
      price: 3,
      hours: 6,
      capacity: 1000,
      accepts: [],
      produces: [snacks],
    },
    {
      id: "transform-stitch",
      merchant: "stitch-works",
      kind: "TRANSFORM",
      name: "Embroidery",
      price: 4.2,
      hours: 24,
      capacity: 20,
      accepts: [hoodie],
      produces: [embroidered],
    },
    {
      id: "transform-thread",
      merchant: "thread-forge",
      kind: "TRANSFORM",
      name: "Embroidery",
      price: 4.5,
      hours: 16,
      capacity: 400,
      accepts: [hoodie],
      produces: [embroidered],
    },
    {
      id: "transform-needle",
      merchant: "needle-north",
      kind: "TRANSFORM",
      name: "Embroidery",
      price: 5.1,
      hours: 20,
      capacity: 300,
      accepts: [hoodie],
      produces: [embroidered],
    },
    {
      id: "transform-laser",
      merchant: "laser-lab",
      kind: "TRANSFORM",
      name: "Engraving",
      price: 3.2,
      hours: 12,
      capacity: 400,
      accepts: [bottle],
      produces: [engraved],
    },
    {
      id: "assemble-pack",
      merchant: "pack-ship",
      kind: "ASSEMBLE",
      name: "Individual assembly",
      price: 2,
      hours: 6,
      capacity: 600,
      accepts: [embroidered, engraved, snacks],
      produces: [kit],
    },
    {
      id: "fulfill-pack",
      merchant: "pack-ship",
      kind: "FULFILL",
      name: "Fulfillment",
      price: 2,
      hours: 12,
      capacity: 600,
      accepts: [kit],
      produces: [kit],
    },
  ];
  return specs.map((spec) => ({
    capabilityId: spec.id,
    merchantId: spec.merchant,
    score: 1,
    blockedReasons: [],
    capability: {
      capabilityId: spec.id,
      merchantId: spec.merchant,
      kind: spec.kind,
      name: spec.name,
      description: `Synthetic demo: ${spec.name}`,
      accepts: spec.accepts,
      produces: spec.produces,
      quantity: { min: 1, max: 1000, unit: "units" },
      pricing: {
        currency: "CAD",
        unitPrice: spec.price,
        setupFee: spec.id === "transform-laser" ? 40 : 0,
      },
      leadTime: { min: spec.hours, max: spec.hours, unit: "hours" },
      capacity: {
        available: spec.capacity,
        maximum: spec.capacity,
        period: "day",
      },
      hardRules: [],
      softRules: [],
      sourceClaimIds: [],
    },
    risk: {
      p50Hours: spec.hours,
      p95Hours: spec.hours,
      p99Hours: spec.hours + 2,
      sampleCount: 100,
      confidence: "high",
    },
  }));
}
