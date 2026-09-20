import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closePool,
  getPool,
  listMerchantClaims,
  migrate,
  reserveCapacity,
  seedDemo,
  transaction,
} from "@molecule/db";
import { kitIntent } from "@molecule/test-fixtures";

import { stableJson } from "./ingestion.js";
import { ingestClaim, resolveMerchant } from "./repository.js";
import { createRealityApp } from "./server.js";
import { createRealityService } from "./service.js";

const database = process.env.TEST_DATABASE_URL;
const now = new Date("2026-09-19T12:00:00.000Z");
const service = createRealityService({ now: () => now });

describe.skipIf(!database)("Rox database and mock marketplace", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    process.env.DEMO_MODE = "true";
    await migrate();
    await seedDemo();
  });
  beforeEach(async () => {
    await service.resetDemo();
  });
  afterAll(closePool);

  it("retains unresolved artifacts through reset without listing the placeholder as a merchant", async () => {
    const artifactId = randomUUID();
    try {
      await getPool().query(
        `insert into raw_artifacts
          (artifact_id,merchant_id,source_kind,source_reference,checksum,raw_content)
         values($1,'m-unresolved','document',$1,$1,'{"supplier":"unidentified"}')`,
        [artifactId],
      );
      await service.resetDemo();
      const merchants = await service.listMerchants();
      expect(merchants.map(({ merchantId }) => merchantId)).not.toContain(
        "m-unresolved",
      );
      expect(
        (
          await getPool().query(
            "select status,is_placeholder from merchants where merchant_id='m-unresolved'",
          )
        ).rows,
      ).toEqual([{ status: "unknown", is_placeholder: true }]);
      expect(
        (
          await getPool().query(
            "select merchant_id,raw_content from raw_artifacts where artifact_id=$1",
            [artifactId],
          )
        ).rows,
      ).toEqual([
        {
          merchant_id: "m-unresolved",
          raw_content: { supplier: "unidentified" },
        },
      ]);
    } finally {
      await getPool().query("delete from raw_artifacts where artifact_id=$1", [
        artifactId,
      ]);
    }
  });

  it.each(["unknown", "offline"] as const)(
    "keeps genuine %s merchants visible without capabilities",
    async (status) => {
      const merchantId = randomUUID();
      try {
        await getPool().query(
          "insert into merchants(merchant_id,name,status) values($1,'Unconfigured supplier',$2)",
          [merchantId, status],
        );
        await service.resetDemo();
        expect(
          (await service.listMerchants()).find(
            (merchant) => merchant.merchantId === merchantId,
          ),
        ).toMatchObject({ merchantId, status, capabilities: [] });
      } finally {
        await getPool().query("delete from merchants where merchant_id=$1", [
          merchantId,
        ]);
      }
    },
  );

  it("excludes any placeholder from listing and candidate search even with an eligible capability", async () => {
    const intent = kitIntent(now);
    expect(
      (await service.searchCandidates(intent)).some(
        ({ merchantId }) => merchantId === "thread-forge",
      ),
    ).toBe(true);
    try {
      await getPool().query(
        "update merchants set is_placeholder=true where merchant_id='thread-forge'",
      );
      expect(
        (await service.listMerchants()).map(({ merchantId }) => merchantId),
      ).not.toContain("thread-forge");
      expect(
        (await service.searchCandidates(intent)).map(
          ({ merchantId }) => merchantId,
        ),
      ).not.toContain("thread-forge");
    } finally {
      await getPool().query(
        "update merchants set is_placeholder=false where merchant_id='thread-forge'",
      );
    }
  });

  it.each(["resolved", "unknown"] as const)(
    "honors %s prefixed inventory in candidate reads and reservations",
    async (status) => {
      const previous = (
        await getPool().query(
          "select normalized_value,resolution_status from canonical_claims where claim_id='demo:cap-base-hoodie:inventory'",
        )
      ).rows[0];
      try {
        await getPool().query(
          `update canonical_claims set normalized_value=$1::jsonb,resolution_status=$2
         where claim_id='demo:cap-base-hoodie:inventory'`,
          [
            status === "resolved" ? "0" : "null",
            status === "resolved" ? "active" : "unknown",
          ],
        );
        // Direct SQL bypasses ingestion, which normally persists resolutions.
        // Candidate reads intentionally do not mutate the database.
        await transaction((client) =>
          resolveMerchant("base-goods", "inventory-fixture", client, now),
        );
        const candidates = await service.searchCandidates(kitIntent(now));
        expect(
          candidates.some((entry) => entry.capabilityId === "cap-base-hoodie"),
        ).toBe(false);
        const request = {
          merchantId: "base-goods",
          capabilityId: "cap-base-hoodie",
          orderId: "inventory-check",
          quantity: 200,
          actionKey: randomUUID(),
        };
        if (status === "unknown") {
          await expect(reserveCapacity(request)).rejects.toMatchObject({
            code: "UNAVAILABLE",
          });
        } else {
          expect(await reserveCapacity(request)).toEqual({
            ok: false,
            reason: "insufficient_capacity",
            available: 0,
          });
        }
      } finally {
        await getPool().query(
          "update canonical_claims set normalized_value=$1::jsonb,resolution_status=$2 where claim_id='demo:cap-base-hoodie:inventory'",
          [
            JSON.stringify(previous.normalized_value),
            previous.resolution_status,
          ],
        );
      }
    },
  );

  it("does not let a global capacity override a stricter scoped capacity", async () => {
    await ingestClaim(
      {
        merchantId: "thread-forge",
        field: "capacity",
        rawValue: 1000,
        sourceKind: "api",
        sourceReference: `demo:chaos:capacity:${randomUUID()}`,
        sourceAuthority: 1,
        extractionConfidence: 1,
      },
      "capacity-limits",
    );
    const candidate = (await service.searchCandidates(kitIntent(now))).find(
      (entry) => entry.capabilityId === "cap-thread-embroidery",
    );
    expect(candidate?.capability.capacity.available).toBe(400);
  });

  it("removes superseded evidence from candidate source claims", async () => {
    const result = await ingestClaim(
      {
        merchantId: "base-goods",
        field: "cap-base-hoodie.price",
        rawValue: 20,
        sourceKind: "api",
        sourceReference: `demo:chaos:price:${randomUUID()}`,
        sourceAuthority: 1,
        extractionConfidence: 1,
      },
      "price-replacement",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const candidate = (await service.searchCandidates(kitIntent(now))).find(
      (entry) => entry.capabilityId === "cap-base-hoodie",
    );
    expect(candidate?.capability.pricing.unitPrice).toBe(20);
    expect(candidate?.capability.sourceClaimIds).toContain(
      result.claim.claimId,
    );
    expect(candidate?.capability.sourceClaimIds).not.toContain(
      "demo:cap-base-hoodie:price",
    );
  });

  it("supersedes older observations from one operational source without erasing them", async () => {
    const sourceReference = `demo:chaos:shopify:inventory:${randomUUID()}`;
    const first = await ingestClaim(
      {
        merchantId: "base-goods",
        field: "capacity_per_day",
        rawValue: 20,
        sourceKind: "shopify",
        sourceReference,
        observedAt: "2026-09-19T12:00:00.000Z",
        sourceAuthority: 0.9,
        extractionConfidence: 1,
      },
      "shopify-first-observation",
    );
    const newest = await ingestClaim(
      {
        merchantId: "base-goods",
        field: "capacity_per_day",
        rawValue: 0,
        sourceKind: "shopify",
        sourceReference,
        observedAt: "2026-09-19T12:01:00.000Z",
        sourceAuthority: 0.9,
        extractionConfidence: 1,
      },
      "shopify-newest-observation",
    );
    const delayed = await ingestClaim(
      {
        merchantId: "base-goods",
        field: "capacity_per_day",
        rawValue: 10,
        sourceKind: "shopify",
        sourceReference,
        observedAt: "2026-09-19T12:00:30.000Z",
        sourceAuthority: 0.9,
        extractionConfidence: 1,
      },
      "shopify-delayed-observation",
    );
    expect(first.ok && newest.ok && delayed.ok).toBe(true);
    if (!first.ok || !newest.ok || !delayed.ok) return;

    const claims = await listMerchantClaims("base-goods");
    expect(
      claims.find((claim) => claim.claimId === first.claim.claimId)
        ?.resolutionStatus,
    ).toBe("superseded");
    expect(
      claims.find((claim) => claim.claimId === delayed.claim.claimId)
        ?.resolutionStatus,
    ).toBe("superseded");
    expect(
      claims.find((claim) => claim.claimId === newest.claim.claimId),
    ).toMatchObject({
      resolutionStatus: "active",
      normalizedValue: 0,
    });
  });

  it("re-resolves offline merchants before filtering search candidates", async () => {
    await ingestClaim(
      {
        merchantId: "thread-forge",
        field: "status",
        rawValue: "online",
        sourceKind: "api",
        sourceReference: `demo:chaos:status:${randomUUID()}`,
        sourceAuthority: 1,
        extractionConfidence: 1,
      },
      "status-recovered",
    );
    await getPool().query(
      "update merchants set status='offline' where merchant_id='thread-forge'",
    );
    expect(
      (await service.searchCandidates(kitIntent(now))).some(
        (entry) => entry.merchantId === "thread-forge",
      ),
    ).toBe(true);
  });

  it("rejects malformed ingestion batches without committing a valid prefix", async () => {
    const app = createRealityApp();
    const sourceReference = `batch:${randomUUID()}`;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/reality/ingest",
        payload: {
          traceId: "invalid-batch",
          claims: [
            {
              merchantId: "base-goods",
              field: "capacity",
              rawValue: 1000,
              sourceKind: "api",
              sourceReference,
              sourceAuthority: 1,
              extractionConfidence: 1,
            },
            null,
          ],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(
        (
          await getPool().query(
            "select 1 from raw_artifacts where source_reference=$1",
            [sourceReference],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("rolls back batch artifacts and events if a later merchant does not exist", async () => {
    const app = createRealityApp();
    const traceId = randomUUID();
    const claim = {
      merchantId: "base-goods",
      field: "capacity",
      rawValue: 1000,
      sourceKind: "api",
      sourceReference: `demo:chaos:batch:${randomUUID()}`,
      sourceAuthority: 1,
      extractionConfidence: 1,
    };
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/reality/ingest",
        payload: {
          traceId,
          claims: [claim, { ...claim, merchantId: "missing-merchant" }],
        },
      });
      expect(response.statusCode).toBe(404);
      expect(
        (
          await getPool().query(
            "select 1 from raw_artifacts where source_reference=$1",
            [claim.sourceReference],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await getPool().query(
            "select 1 from molecule_events where trace_id=$1",
            [traceId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("returns every kit component and daily-capacity options for solver certification", async () => {
    const candidates = await service.searchCandidates(kitIntent(now));
    expect(candidates.map((entry) => entry.capabilityId).sort()).toEqual([
      "cap-base-bottle",
      "cap-base-hoodie",
      "cap-laser-engraving",
      "cap-needle-embroidery",
      "cap-pack-assembly",
      "cap-pack-fulfillment",
      "cap-snacks",
      "cap-stitch-embroidery",
      "cap-thread-embroidery",
    ]);
    expect(await service.searchCandidates(kitIntent(now))).toEqual(candidates);
    expect(
      candidates.every(
        (entry) =>
          entry.risk?.sampleCount === 100 &&
          entry.capability.sourceClaimIds.length >= 3,
      ),
    ).toBe(true);
    const cost = candidates
      .filter(
        (entry) => !["needle-north", "stitch-works"].includes(entry.merchantId),
      )
      .reduce(
        (total, entry) =>
          total +
          200 * (entry.capability.pricing.unitPrice ?? Infinity) +
          (entry.capability.pricing.setupFee ?? 0),
        0,
      );
    expect(cost).toBe(6395);
    const demoIds = new Set(
      (
        await getPool().query<{ merchant_id: string }>(
          "select merchant_id from merchants where demo_tag='MOLECULE_DEMO'",
        )
      ).rows.map(({ merchant_id }) => merchant_id),
    );
    const merchants = (await service.listMerchants()).filter(({ merchantId }) =>
      demoIds.has(merchantId),
    );
    expect(merchants).toHaveLength(7);
    expect(
      merchants.every(
        (merchant) => merchant.documents.length && merchant.policies.length,
      ),
    ).toBe(true);
    const stitch = merchants.find(
      (merchant) => merchant.merchantId === "stitch-works",
    );
    expect(
      stitch?.claims.find((claim) => claim.claimId === "demo:stitch:outage")
        ?.resolutionStatus,
    ).toBe("active");
    expect(
      stitch?.claims.find((claim) => claim.claimId === "demo:stitch:web")
        ?.resolutionStatus,
    ).toBe("superseded");
    expect(stitch?.capabilities[0]?.capability.capacity.available).toBe(20);
  });

  it("reads merchant summaries without waiting for the global writer lock", async () => {
    const client = await getPool().connect();
    let operation: ReturnType<typeof service.listMerchants> | undefined;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(73481203)");
      operation = service.listMerchants();
      const outcome = await Promise.race([
        operation.then(() => "completed" as const),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 2_000),
        ),
      ]);
      expect(outcome).toBe("completed");
    } finally {
      await client.query("rollback");
      client.release();
      await operation;
    }
  });

  it("honors scoped/global materials, exclusions, deadline, currency and reservations", async () => {
    const intent = kitIntent(now);
    intent.hardConstraints.push({
      constraintId: "no-polyester",
      field: "material",
      operator: "not_contains",
      value: "polyester",
    });
    const candidates = await service.searchCandidates(intent, ["thread-forge"]);
    expect(candidates).toHaveLength(8);
    expect(
      candidates.some((entry) => entry.merchantId === "needle-north"),
    ).toBe(true);
    expect(
      candidates.some((entry) => entry.merchantId === "thread-forge"),
    ).toBe(false);
    expect(
      await service.searchCandidates({ ...intent, currency: "USD" }),
    ).toEqual([]);
    expect(
      await service.searchCandidates({
        ...intent,
        deadline: now.toISOString(),
      }),
    ).toEqual([]);
    await reserveCapacity({
      merchantId: "thread-forge",
      capabilityId: "cap-thread-embroidery",
      orderId: "held",
      quantity: 400,
      actionKey: randomUUID(),
    });
    expect(
      (await service.searchCandidates(intent)).some(
        (entry) => entry.merchantId === "thread-forge",
      ),
    ).toBe(false);
  });

  it.each([
    "supplier_offline",
    "inventory_zero",
    "price_spike",
    "lead_time_delay",
    "conflicting_document",
  ] as const)(
    "persists and reverses %s without duplicate effects",
    async (scenario) => {
      const merchantId =
        scenario === "inventory_zero" ? "base-goods" : "thread-forge";
      const request = { scenario, merchantId };
      const traceId = randomUUID();
      const initial = await service.searchCandidates(kitIntent(now));
      await service.applyChaos(request, traceId);
      const firstCount = (
        await getPool().query("select count(*) from molecule_events")
      ).rows[0].count;
      await service.applyChaos(request, traceId);
      expect(
        (await getPool().query("select count(*) from molecule_events")).rows[0]
          .count,
      ).toBe(firstCount);
      const changed = await service.searchCandidates(kitIntent(now));
      if (scenario === "price_spike") {
        expect(
          changed.find((entry) => entry.merchantId === merchantId)?.capability
            .pricing.unitPrice,
        ).toBe(13.5);
      } else {
        expect(changed.some((entry) => entry.merchantId === merchantId)).toBe(
          false,
        );
      }
      if (scenario === "conflicting_document") {
        expect(
          (
            await getPool().query(
              "select status,value from canonical_resolutions where merchant_id=$1 and field='cap-thread-embroidery.price'",
              [merchantId],
            )
          ).rows,
        ).toEqual([{ status: "conflicted", value: null }]);
      }
      expect(changed.some((entry) => entry.merchantId === "needle-north")).toBe(
        true,
      );
      await service.resetDemo();
      expect(await service.searchCandidates(kitIntent(now))).toEqual(initial);
    },
  );

  it("retains exact raw values, hashes and references; quarantines malformed rows once", async () => {
    const input = {
      merchantId: "base-goods",
      field: "test.capacity",
      rawValue: "twenty?",
      sourceKind: "csv" as const,
      sourceReference: `test:${randomUUID()}`,
      sourceAuthority: 0.9,
      extractionConfidence: 0.9,
    };
    expect((await ingestClaim(input, "quarantine-test")).ok).toBe(false);
    expect((await ingestClaim(input, "quarantine-test")).ok).toBe(false);
    const artifacts = await getPool().query(
      "select * from raw_artifacts where source_reference=$1",
      [input.sourceReference],
    );
    expect(artifacts.rows).toHaveLength(1);
    expect(artifacts.rows[0].raw_content).toEqual(input);
    expect(artifacts.rows[0].checksum).toBe(
      createHash("sha256").update(stableJson(input)).digest("hex"),
    );
    expect(
      (
        await getPool().query(
          "select count(*) from quarantined_claims where artifact_id=$1",
          [artifacts.rows[0].artifact_id],
        )
      ).rows[0].count,
    ).toBe("1");
  });

  it("prevents equal authority prices from entering candidates", async () => {
    for (const rawValue of [10, 20]) {
      await ingestClaim(
        {
          merchantId: "base-goods",
          field: "cap-base-hoodie.price",
          rawValue,
          sourceKind: "document",
          sourceReference: `demo:chaos:test:${randomUUID()}`,
          observedAt: now.toISOString(),
          sourceAuthority: 1,
          extractionConfidence: 1,
        },
        "price-conflict",
      );
    }
    expect(
      (await service.searchCandidates(kitIntent(now))).some(
        (entry) => entry.capabilityId === "cap-base-hoodie",
      ),
    ).toBe(false);
  });

  it("serves validated HTTP requests without listening at import time", async () => {
    const app = createRealityApp({ now: () => now });
    const response = await app.inject({
      method: "POST",
      url: "/api/candidates/search",
      payload: { intent: kitIntent(now) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidates).toHaveLength(9);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/candidates/search",
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject("/health")).json().candidateSearch).toBe(
      "lexical",
    );
    await app.close();
  });

  it("reports canonical offline status and preserves duplicate ingestion timestamps", async () => {
    const input = {
      merchantId: "thread-forge",
      field: "status",
      rawValue: "offline",
      sourceKind: "manual" as const,
      sourceReference: `demo:chaos:status:${randomUUID()}`,
      observedAt: now.toISOString(),
      sourceAuthority: 1,
      extractionConfidence: 1,
    };
    const first = await ingestClaim(input, "status-test");
    expect(await ingestClaim(input, "status-test")).toEqual(first);
    expect(
      (await service.listMerchants()).find(
        (entry) => entry.merchantId === "thread-forge",
      )?.status,
    ).toBe("offline");
    expect(
      (await service.searchCandidates(kitIntent(now))).some(
        (entry) => entry.merchantId === "thread-forge",
      ),
    ).toBe(false);
  });

  it("rolls back invalid chaos targets instead of reporting a no-op success", async () => {
    const traceId = randomUUID();
    await expect(
      service.applyChaos(
        { scenario: "inventory_zero", merchantId: "thread-forge" },
        traceId,
      ),
    ).rejects.toThrow("supply merchant");
    expect(
      (
        await getPool().query(
          "select count(*) from demo_chaos_actions where trace_id=$1",
          [traceId],
        )
      ).rows[0].count,
    ).toBe("0");
    await service.applyChaos(
      { scenario: "conflicting_document", merchantId: "thread-forge" },
      randomUUID(),
    );
    await expect(
      service.applyChaos(
        { scenario: "price_spike", merchantId: "thread-forge" },
        randomUUID(),
      ),
    ).rejects.toThrow("unresolved price");
  });
});
