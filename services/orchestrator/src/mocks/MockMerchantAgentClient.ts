import type { QuoteRequest, QuoteResponse } from "@molecule/contracts";

import type { MerchantAgentClient } from "../clients.js";
import { demoCandidates } from "./demoCatalog.js";

export class MockMerchantAgentClient implements MerchantAgentClient {
  constructor(private readonly delayMs = 0) {}

  async quote(
    request: QuoteRequest,
    signal?: AbortSignal,
  ): Promise<QuoteResponse> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    const candidate = demoCandidates().find(
      ({ capabilityId, merchantId }) =>
        capabilityId === request.capabilityId &&
        merchantId === request.merchantId,
    );
    if (!candidate) throw new Error("Unknown demo capability");
    return {
      merchantId: request.merchantId,
      capabilityId: request.capabilityId,
      status: "CAN_ACCEPT",
      unitPrice: candidate.capability.pricing.unitPrice,
      setupFee: candidate.capability.pricing.setupFee,
      currency: request.currency,
      maxQuantity: candidate.capability.capacity.available,
      completionEstimate: new Date(
        Date.now() + candidate.capability.leadTime.max * 3600000,
      ).toISOString(),
      requiredChanges: [],
      confidence: 0.95,
      explanation: "Mock merchant has verified capacity.",
    };
  }
}
