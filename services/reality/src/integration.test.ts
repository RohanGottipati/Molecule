import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closePool,
  getPool,
  migrate,
  reserveCapacity,
  seedDemo,
} from "@molecule/db";
import { kitIntent } from "@molecule/test-fixtures";

import { stableJson } from "./ingestion.js";
import { ingestClaim } from "./repository.js";
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

  it("returns every kit component, two embroidery options, evidence and risk without certifying a plan", async () => {
    const candidates = await service.searchCandidates(kitIntent(now));
    expect(candidates.map((entry) => entry.capabilityId).sort()).toEqual([
      "cap-base-bottle",
      "cap-base-hoodie",
      "cap-laser-engraving",
      "cap-needle-embroidery",
      "cap-pack-assembly",
      "cap-pack-fulfillment",
      "cap-snacks",
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
      .filter((entry) => entry.merchantId !== "needle-north")
      .reduce(
        (total, entry) =>
          total +
          200 * (entry.capability.pricing.unitPrice ?? Infinity) +
          (entry.capability.pricing.setupFee ?? 0),
        0,
      );
    expect(cost).toBe(6395);
    const merchants = await service.listMerchants();
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

  it("honors scoped/global materials, exclusions, deadline, currency and reservations", async () => {
    const intent = kitIntent(now);
    intent.hardConstraints.push({
      constraintId: "no-polyester",
      field: "material",
      operator: "not_contains",
      value: "polyester",
    });
    const candidates = await service.searchCandidates(intent, ["thread-forge"]);
    expect(candidates).toHaveLength(7);
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
      quantity: 201,
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
    const app = createRealityApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/candidates/search",
      payload: { intent: kitIntent(now) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidates).toHaveLength(8);
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
