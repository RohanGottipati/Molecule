import type { QuoteRequest, QuoteResponse } from "@molecule/contracts";

import type { MerchantAgentClient } from "../clients.js";

const prices: Record<string, number> = {
  "supply-base": 12,
  "supply-backup": 12,
  "transform-stitch": 4.5,
  "transform-thread": 5.1,
  "assemble-pack": 2,
  "fulfill-pack": 3,
};

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
    return {
      merchantId: request.merchantId,
      capabilityId: request.capabilityId,
      status: "CAN_ACCEPT",
      unitPrice: prices[request.capabilityId] ?? 10,
      setupFee: 0,
      currency: request.currency,
      maxQuantity: 1_000,
      completionEstimate: request.deadline,
      requiredChanges: [],
      confidence: 0.95,
      explanation: "Mock merchant has verified capacity.",
    };
  }
}
