import { randomUUID } from "node:crypto";

import Fastify from "fastify";

import { ProductIntentSchema, type ProductIntent } from "@molecule/contracts";
import { transaction } from "@molecule/db";

import type { RawClaimInput } from "./ingestion.js";
import { ingestClaim, resolveMerchant } from "./repository.js";
import { createRealityService, realityHealth } from "./service.js";

export function createRealityApp() {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const service = createRealityService();
  app.get("/health", realityHealth);
  app.get("/api/reality/merchants", () => service.listMerchants());
  app.post<{ Body: { intent: ProductIntent; excludedMerchantIds?: string[] } }>(
    "/api/candidates/search",
    async (request) => ({
      candidates: await service.searchCandidates(
        ProductIntentSchema.parse(request.body?.intent),
        request.body.excludedMerchantIds,
      ),
      method: "lexical",
    }),
  );
  app.post<{ Body: { claims: RawClaimInput[]; traceId: string } }>(
    "/api/reality/ingest",
    async (request, reply) => {
      const { claims, traceId } = request.body;
      if (
        !Array.isArray(claims) ||
        typeof traceId !== "string" ||
        !traceId.trim()
      )
        return reply.code(400).send({ error: "claims and traceId required" });
      const acceptedClaimIds: string[] = [];
      const quarantined: { field: string; reason: string }[] = [];
      for (const claim of claims) {
        const result = await ingestClaim(claim, traceId);
        if (result.ok) acceptedClaimIds.push(result.claim.claimId);
        else quarantined.push({ field: claim.field, reason: result.reason });
      }
      return reply.code(202).send({ acceptedClaimIds, quarantined });
    },
  );
  app.post<{ Body: { merchantId: string; field: string; traceId: string } }>(
    "/api/reality/resolve",
    async (request, reply) => {
      const { merchantId, field, traceId } = request.body;
      if (
        [merchantId, field, traceId].some(
          (value) => typeof value !== "string" || !value.trim(),
        )
      )
        return reply
          .code(400)
          .send({ error: "merchantId, field and traceId required" });
      return transaction(
        async (client) =>
          (await resolveMerchant(merchantId, traceId, client)).find(
            (fact) => fact.field === field,
          ) ?? {
            field,
            status: "unknown",
            explanation: "No claims for this field",
          },
      );
    },
  );
  app.setErrorHandler((error, _request, reply) => {
    const validation = error instanceof Error && error.name === "ZodError";
    return reply.code(validation ? 400 : 500).send({
      code: validation ? "VALIDATION_ERROR" : "INTERNAL",
      message: validation ? "Invalid request" : "Reality operation failed",
      traceId: randomUUID(),
      retryable: !validation,
    });
  });
  return app;
}

export const app = createRealityApp();
