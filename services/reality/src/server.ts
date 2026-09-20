import { randomUUID } from "node:crypto";

import Fastify from "fastify";

import { ProductIntentSchema, type ProductIntent } from "@molecule/contracts";
import { transaction } from "@molecule/db";

import type { RawClaimInput } from "./ingestion.js";
import { ingestClaim, resolveMerchant } from "./repository.js";
import { createRealityService, realityHealth } from "./service.js";

export function createRealityApp(options: { now?: () => Date } = {}) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
    ajv: { customOptions: { coerceTypes: false } },
  });
  const service = createRealityService(options);
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
    {
      schema: {
        body: {
          type: "object",
          required: ["claims", "traceId"],
          properties: {
            traceId: { type: "string", pattern: "\\S" },
            claims: {
              type: "array",
              items: {
                type: "object",
                required: ["merchantId", "field", "sourceReference"],
                properties: {
                  merchantId: { type: "string", pattern: "\\S" },
                  field: { type: "string", pattern: "\\S" },
                  sourceReference: { type: "string", pattern: "\\S" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { claims, traceId } = request.body;
      const result = await transaction(async (client) => {
        const acceptedClaimIds: string[] = [];
        const quarantined: {
          field: string;
          reason: string;
          disposition?: "needs_review" | "quarantine";
          code?: string;
        }[] = [];
        for (const claim of claims) {
          const result = await ingestClaim(claim, traceId, client);
          if (result.ok) acceptedClaimIds.push(result.claim.claimId);
          else
            quarantined.push({
              field: claim.field,
              reason: result.reason,
              disposition: result.disposition,
              code: result.code,
            });
        }
        return { acceptedClaimIds, quarantined };
      });
      return reply.code(202).send(result);
    },
  );
  app.post<{ Body: { merchantId: string; field: string; traceId: string } }>(
    "/api/reality/resolve",
    {
      schema: {
        body: {
          type: "object",
          required: ["merchantId", "field", "traceId"],
          properties: {
            merchantId: { type: "string", pattern: "\\S" },
            field: { type: "string", pattern: "\\S" },
            traceId: { type: "string", pattern: "\\S" },
          },
        },
      },
    },
    async (request) => {
      const { merchantId, field, traceId } = request.body;
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
    const status =
      error instanceof Error && error.name === "ZodError"
        ? 400
        : error instanceof Error &&
            "statusCode" in error &&
            typeof error.statusCode === "number" &&
            error.statusCode >= 400 &&
            error.statusCode < 500
          ? error.statusCode
          : 500;
    return reply.code(status).send({
      code: status < 500 ? "VALIDATION_ERROR" : "INTERNAL",
      message: status < 500 ? "Invalid request" : "Reality operation failed",
      traceId: randomUUID(),
      retryable: status >= 500,
    });
  });
  return app;
}

export const app = createRealityApp();
