import {
  QuoteRequestSchema,
  QuoteResponseSchema,
  type QuoteRequest,
  type QuoteResponse,
} from "@molecule/contracts";
import { transaction } from "@molecule/db";
import { catalogCandidates } from "./catalog.js";

/** Quantity-specific quote from the current validated supplier offer, never model memory. */
export async function quoteCatalog(
  input: QuoteRequest,
): Promise<QuoteResponse> {
  const request = QuoteRequestSchema.parse(input);
  return transaction(async (client) => {
    const report = await catalogCandidates(
      client,
      undefined,
      [],
      request.selectedItem?.bindingId,
    );
    const candidate = report.candidates.find(
      (c) =>
        c.capabilityId === request.capabilityId &&
        c.merchantId === request.merchantId,
    );
    const decline = (explanation: string) =>
      QuoteResponseSchema.parse({
        merchantId: request.merchantId,
        capabilityId: request.capabilityId,
        status: "DECLINE",
        currency: request.currency,
        confidence: 1,
        explanation,
      });
    if (
      !candidate ||
      request.catalogVersion !== candidate.catalogVersion ||
      JSON.stringify(request.selectedItem) !==
        JSON.stringify(candidate.selectedItem)
    )
      return decline(
        "The selected catalog offer changed or lacks resolved evidence; rediscover candidates.",
      );
    if (request.hold)
      return decline(
        "Catalog resources are reserved atomically for the solver's complete scheduled plan.",
      );
    const cap = candidate.capability;
    if (
      request.currency !== cap.pricing.currency ||
      request.quantity < cap.quantity.min ||
      request.quantity > cap.quantity.max
    )
      return decline("Quantity or currency falls outside the published offer.");
    if (
      candidate.resourceRefs?.some(
        (r) =>
          r.kind === "inventory" &&
          r.available < request.quantity * r.unitsPerItem,
      )
    )
      return decline("Selected inventory is insufficient.");
    return QuoteResponseSchema.parse({
      merchantId: candidate.merchantId,
      capabilityId: candidate.capabilityId,
      status: "CAN_ACCEPT",
      currency: cap.pricing.currency,
      unitPrice: cap.pricing.unitPrice,
      setupFee: cap.pricing.setupFee,
      maxQuantity: Math.floor(cap.quantity.max),
      confidence: 1,
      explanation: `${candidate.synthetic ? "Synthetic operating facts. " : ""}Current versioned offer; feasibility and scheduling require the solver.`,
      catalogVersion: candidate.catalogVersion,
      selectedItem: candidate.selectedItem,
      quotedQuantity: request.quantity,
    });
  });
}
