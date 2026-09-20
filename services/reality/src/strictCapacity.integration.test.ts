import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool, migrate } from "@molecule/db";

import { createRealityApp } from "./server.js";

const database = process.env.TEST_DATABASE_URL;
const merchantId = `strict-capacity-${randomUUID()}`;

describe.skipIf(!database)("strict capacity API ingestion", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    await migrate();
    await getPool().query(
      "insert into merchants(merchant_id,name,status) values($1,'Strict capacity fixture','online')",
      [merchantId],
    );
  });

  afterAll(async () => {
    await getPool().query("delete from rox_review_queue where merchant_id=$1", [
      merchantId,
    ]);
    await getPool().query(
      "delete from quarantined_claims where artifact_id in (select artifact_id from raw_artifacts where merchant_id=$1)",
      [merchantId],
    );
    await getPool().query("delete from raw_artifacts where merchant_id=$1", [
      merchantId,
    ]);
    await getPool().query("delete from merchants where merchant_id=$1", [
      merchantId,
    ]);
    await closePool();
  });

  it("returns needs_review:no_period and queues review for a bare number", async () => {
    const app = createRealityApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/reality/ingest",
        payload: {
          traceId: `strict-capacity:${randomUUID()}`,
          claims: [
            {
              merchantId,
              field: "cap-strict.capacity_per_day",
              rawValue: "500",
              sourceKind: "document",
              sourceReference: "document:bare-capacity",
              sourceAuthority: 0.8,
              extractionConfidence: 0.9,
              evidenceText: "Current capacity is 500.",
            },
          ],
        },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        acceptedClaimIds: [],
        quarantined: [
          {
            field: "cap-strict.capacity_per_day",
            disposition: "needs_review",
            code: "no_period",
          },
        ],
      });
      expect(
        (
          await getPool().query(
            "select count(*) from rox_review_queue where merchant_id=$1 and detail->>'code'='no_period'",
            [merchantId],
          )
        ).rows[0].count,
      ).toBe("1");
      expect(
        (
          await getPool().query(
            "select count(*) from canonical_claims where merchant_id=$1",
            [merchantId],
          )
        ).rows[0].count,
      ).toBe("0");
    } finally {
      await app.close();
    }
  });
});
