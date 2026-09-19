import type {
  CandidateCapability,
  MerchantCapability,
  ProductIntent,
} from "@molecule/contracts";

import type { RealityClient } from "../clients.js";

function capability(
  merchantId: string,
  capabilityId: string,
  kind: MerchantCapability["kind"],
  name: string,
  unitPrice: number,
  p95Hours: number,
): CandidateCapability {
  return {
    capabilityId,
    merchantId,
    score: 0.9,
    capability: {
      capabilityId,
      merchantId,
      kind,
      name,
      description: `${name} using verified cotton-compatible processes`,
      accepts: [],
      produces: [
        {
          kind: "product",
          name,
          attributes: { material: "cotton" },
        },
      ],
      quantity: { min: 1, max: 1_000, unit: "units" },
      pricing: { currency: "CAD", unitPrice, setupFee: 0 },
      leadTime: { min: p95Hours / 2, max: p95Hours, unit: "hours" },
      capacity: {
        available: 1_000,
        maximum: 1_000,
        period: "day",
        asOf: new Date().toISOString(),
      },
      hardRules: [],
      softRules: [],
      sourceClaimIds: [`claim-${capabilityId}`],
    },
    risk: {
      p50Hours: p95Hours / 2,
      p95Hours,
      p99Hours: p95Hours * 1.2,
      sampleCount: 100,
      confidence: "high",
    },
    blockedReasons: [],
  };
}

export class MockRealityClient implements RealityClient {
  async searchCandidates(
    intent: ProductIntent,
    excludedMerchantIds: string[] = [],
  ): Promise<CandidateCapability[]> {
    const requiresAssembly = intent.transformations.some(({ kind }) =>
      /assembl|pack/i.test(kind),
    );
    const requiresFulfillment = intent.transformations.some(({ kind }) =>
      /fulfill|ship/i.test(kind),
    );
    const requiresTransform = intent.transformations.some(
      ({ kind }) => !/assembl|pack|fulfill|ship/i.test(kind),
    );
    return [
      capability(
        "base-goods",
        "supply-base",
        "SUPPLY",
        "Base cotton goods",
        12,
        12,
      ),
      capability(
        "base-goods-2",
        "supply-backup",
        "SUPPLY",
        "Backup cotton goods",
        13,
        10,
      ),
      ...(requiresTransform
        ? [
            capability(
              "stitch-works",
              "transform-stitch",
              "TRANSFORM",
              "Embroidery",
              4.5,
              72,
            ),
            capability(
              "thread-forge",
              "transform-thread",
              "TRANSFORM",
              "Embroidery backup",
              5.1,
              20,
            ),
          ]
        : []),
      ...(requiresAssembly
        ? [
            capability(
              "pack-ship",
              "assemble-pack",
              "ASSEMBLE",
              "Assembly",
              2,
              8,
            ),
          ]
        : []),
      ...(requiresFulfillment
        ? [
            capability(
              "pack-ship",
              "fulfill-pack",
              "FULFILL",
              "Fulfillment",
              3,
              12,
            ),
          ]
        : []),
    ].filter((item) => !excludedMerchantIds.includes(item.merchantId));
  }
}
