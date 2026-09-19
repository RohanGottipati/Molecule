import { randomUUID } from "node:crypto";

import Fastify from "fastify";

import { insertClaim, listClaimsForField, setClaimStatus, upsertConflict } from "@molecule/db";
import { appendEvent } from "@molecule/events";

import { toCanonicalClaim, type RawClaimInput } from "./ingestion.js";
import { explainResolution, resolveClaims } from "./resolution.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok", service: "reality" }));

// POST /api/reality/ingest — source artifact(s) -> CanonicalClaim[]
// Contract: docs/CONTRACTS.md "Preserve source and confidence"
app.post<{ Body: { claims: RawClaimInput[]; traceId?: string } }>(
  "/api/reality/ingest",
  async (request, reply) => {
    const { claims, traceId = randomUUID() } = request.body;
    const accepted: string[] = [];
    const quarantined: Array<{ input: RawClaimInput; reason: string }> = [];

    for (const raw of claims) {
      const result = toCanonicalClaim(raw);
      if (!result.ok) {
        quarantined.push({ input: raw, reason: result.reason });
        continue;
      }
      await insertClaim(result.claim);
      accepted.push(result.claim.claimId);
      await appendEvent({
        eventId: randomUUID(),
        traceId,
        merchantId: result.claim.merchantId,
        eventType: "reality.claim.ingested",
        severity: "INFO",
        source: "rox",
        ts: new Date().toISOString(),
        payload: { claimId: result.claim.claimId, field: result.claim.field },
      });
    }

    for (const q of quarantined) {
      await appendEvent({
        eventId: randomUUID(),
        traceId,
        merchantId: q.input.merchantId,
        eventType: "reality.claim.conflict",
        severity: "WARN",
        source: "rox",
        ts: new Date().toISOString(),
        payload: { field: q.input.field, reason: q.reason, quarantined: true },
      });
    }

    return reply.code(202).send({
      acceptedClaimIds: accepted,
      quarantined: quarantined.map((q) => ({ field: q.input.field, reason: q.reason })),
    });
  },
);

// POST /api/reality/resolve — merchant/field -> resolved value, with provenance.
// Contract: docs/CONTRACTS.md "Conflicted/unknown are valid outcomes"
app.post<{ Body: { merchantId: string; field: string; traceId?: string } }>(
  "/api/reality/resolve",
  async (request) => {
    const { merchantId, field, traceId = randomUUID() } = request.body;
    const claims = await listClaimsForField(merchantId, field);
    const result = resolveClaims(claims);
    const explanation = explainResolution(result);

    if (result.status === "resolved") {
      for (const loser of result.losers) {
        await setClaimStatus(loser.claim.claimId, "superseded");
      }
      await appendEvent({
        eventId: randomUUID(),
        traceId,
        merchantId,
        eventType: "reality.claim.resolved",
        severity: "INFO",
        source: "rox",
        ts: new Date().toISOString(),
        payload: { field, value: result.winner.claim.normalizedValue, explanation },
      });
      return {
        status: "resolved",
        value: result.winner.claim.normalizedValue,
        unit: result.winner.claim.normalizedUnit,
        winningClaimId: result.winner.claim.claimId,
        explanation,
      };
    }

    if (result.status === "conflicted") {
      const conflictId = await upsertConflict(
        merchantId,
        field,
        result.contenders.map((c) => c.claim.claimId),
      );
      for (const c of result.contenders) {
        await setClaimStatus(c.claim.claimId, "conflicted");
      }
      await appendEvent({
        eventId: randomUUID(),
        traceId,
        merchantId,
        eventType: "reality.claim.conflict",
        severity: "WARN",
        source: "rox",
        ts: new Date().toISOString(),
        payload: { field, conflictId, explanation },
      });
      return { status: "conflicted", conflictId, explanation };
    }

    return { status: "unknown", explanation };
  },
);

// POST /api/candidates/search — ranks candidates, never certifies compatibility.
// Contract: docs/CONTRACTS.md "Search is candidate generation only"
app.post<{ Body: { query: string; topK?: number } }>(
  "/api/candidates/search",
  async (request) => {
    // Vector search over capability_embeddings lands with T4; until then this
    // is a placeholder that returns an empty, explicitly-unranked result so
    // callers don't mistake "not implemented" for "no matches".
    return { query: request.body.query, candidates: [], note: "vector search not yet implemented" };
  },
);

export { app };

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.REALITY_PORT ?? 3002);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
