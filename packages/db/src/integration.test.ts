import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closePool,
  effectId,
  expireReservations,
  getDatabaseFeatures,
  getMerchantRisk,
  getOperationsMetrics,
  getPool,
  migrate,
  persistEvent,
  releaseReservation,
  reserveCapacity,
  resetDemoData,
  seedDemo,
  transaction,
} from "./index.js";

const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)("real PostgreSQL operational store", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    process.env.DEMO_MODE = "true";
    await migrate();
    await seedDemo();
  });
  beforeEach(async () => {
    await resetDemoData();
  });
  afterAll(closePool);

  it("keeps demo baselines immutable when seed is rerun after an operational change", async () => {
    const before = (
      await getPool().query(
        "select capability_json from demo_capability_baselines where capability_id='cap-base-hoodie'",
      )
    ).rows[0].capability_json;
    await getPool().query(
      `update capabilities set capability_json=jsonb_set(capability_json,'{capacity,available}','0')
       where capability_id='cap-base-hoodie'`,
    );
    await seedDemo();
    expect(
      (
        await getPool().query(
          "select capability_json from demo_capability_baselines where capability_id='cap-base-hoodie'",
        )
      ).rows[0].capability_json,
    ).toEqual(before);
    await resetDemoData();
    expect(
      (
        await getPool().query(
          "select capability_json from capabilities where capability_id='cap-base-hoodie'",
        )
      ).rows[0].capability_json,
    ).toEqual(before);
  });

  const input = () => ({
    merchantId: "thread-forge",
    capabilityId: "cap-thread-embroidery",
    orderId: `test:${randomUUID()}`,
    quantity: 200,
    actionKey: `test:${randomUUID()}`,
    traceId: "db-test",
  });

  it("reruns migrate/seed without deleting rows or duplicating history", async () => {
    const before = await getPool().query(
      "select count(*) from fulfillment_samples",
    );
    await migrate();
    await seedDemo();
    await seedDemo();
    expect(
      (await getPool().query("select count(*) from fulfillment_samples")).rows,
    ).toEqual(before.rows);
    expect((await getDatabaseFeatures()).candidateSearch).toBe("lexical");
    expect(
      await getMerchantRisk("needle-north", "cap-needle-embroidery"),
    ).toEqual({
      p50Hours: 24.5,
      p95Hours: 29,
      p99Hours: 29,
      sampleCount: 100,
      confidence: "high",
    });
    expect(await getMerchantRisk("missing", "missing")).toEqual({
      sampleCount: 0,
      confidence: "low",
    });
  });

  it("serializes competing holds and never oversells", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reserveCapacity(input())),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok)).toHaveLength(10);
    expect(
      Number(
        (
          await getPool().query(
            "select sum(quantity) from reservations where capability_id='cap-thread-embroidery' and status='active'",
          )
        ).rows[0].sum,
      ),
    ).toBe(400);
  });

  it("deduplicates concurrent identical action keys and rejects changed arguments", async () => {
    const request = input();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveCapacity(request)),
    );
    const ids = results.map((result) =>
      result.ok ? result.reservation.reservationId : "failed",
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe("failed");
    for (const change of [
      { quantity: 201 },
      { merchantId: "needle-north" },
      { capabilityId: "cap-needle-embroidery" },
      { orderId: "different" },
      { ttlSeconds: 60 },
    ]) {
      await expect(
        reserveCapacity({ ...request, ...change }),
      ).rejects.toMatchObject({ code: "ACTION_KEY_MISMATCH" });
    }
    expect(
      (
        await getPool().query(
          "select count(*) from molecule_events where event_id=$1",
          [effectId(`reservation:${request.actionKey}`)],
        )
      ).rows[0].count,
    ).toBe("1");
  });

  it("validates quantities, TTL and capability ownership", async () => {
    for (const quantity of [0, -1, 0.5, NaN, Infinity]) {
      await expect(
        reserveCapacity({ ...input(), quantity }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    await expect(
      reserveCapacity({ ...input(), ttlSeconds: -1 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      reserveCapacity({ ...input(), merchantId: "needle-north" }),
    ).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
  });

  it("honors scoped daily-capacity facts and rejects empty trace IDs", async () => {
    await expect(
      reserveCapacity({ ...input(), traceId: " " }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await getPool()
      .query(`insert into canonical_resolutions(merchant_id,field,status,explanation,scores)
      values('thread-forge','cap-thread-embroidery.capacity_per_day','unknown','Unverified daily capacity','{}')`);
    await expect(reserveCapacity(input())).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await getPool()
      .query(`update canonical_resolutions set status='resolved',value='50'
      where merchant_id='thread-forge' and field='cap-thread-embroidery.capacity_per_day'`);
    expect(await reserveCapacity(input())).toEqual({
      ok: false,
      reason: "insufficient_capacity",
      available: 50,
    });
  });

  it("compares reservation capacity on the winning claim's daily time basis", async () => {
    await getPool()
      .query(`update capabilities set capability_json=jsonb_set(capability_json,'{capacity}',
      '{"available":700,"maximum":1400,"period":"week"}') where capability_id='cap-thread-embroidery'`);
    await getPool()
      .query(`update canonical_claims set normalized_value='200',normalized_unit='units/day'
      where claim_id='demo:cap-thread-embroidery:capacity'`);
    const inserted = await getPool().query(`insert into canonical_resolutions(merchant_id,field,status,winning_claim_id,value,explanation,scores)
      select merchant_id,field,'resolved',claim_id,normalized_value,'Unit regression fixture','{}'
      from canonical_claims where claim_id='demo:cap-thread-embroidery:capacity'
      on conflict(merchant_id,field) do update set winning_claim_id=excluded.winning_claim_id,value=excluded.value,status='resolved'`);
    expect(inserted.rowCount).toBe(1);
    expect(await reserveCapacity(input())).toEqual({
      ok: false,
      reason: "insufficient_capacity",
      available: 100,
    });
    expect((await reserveCapacity({ ...input(), quantity: 100 })).ok).toBe(
      true,
    );
    expect(await reserveCapacity({ ...input(), quantity: 1 })).toEqual({
      ok: false,
      reason: "insufficient_capacity",
      available: 0,
    });
    const stored = await getPool()
      .query(`select capability_json->'capacity' as capacity from capabilities
      where capability_id='cap-thread-embroidery'`);
    expect(stored.rows[0].capacity).toEqual({
      available: 700,
      maximum: 1400,
      period: "week",
    });
  });

  it("refuses incompatible winning capacity units before creating a hold", async () => {
    await getPool().query(`update canonical_claims set normalized_unit='kg/day'
      where claim_id='demo:cap-thread-embroidery:capacity'`);
    const inserted = await getPool().query(`insert into canonical_resolutions(merchant_id,field,status,winning_claim_id,value,explanation,scores)
      select merchant_id,field,'resolved',claim_id,normalized_value,'Unit regression fixture','{}'
      from canonical_claims where claim_id='demo:cap-thread-embroidery:capacity'
      on conflict(merchant_id,field) do update set winning_claim_id=excluded.winning_claim_id,value=excluded.value,status='resolved'`);
    expect(inserted.rowCount).toBe(1);
    await expect(reserveCapacity(input())).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(
      (
        await getPool().query(
          `select count(*) as count from reservations where status='active'`,
        )
      ).rows[0].count,
    ).toBe("0");
  });

  it("releases and expires holds without reviving inactive retries", async () => {
    const request = input();
    const first = await reserveCapacity(request);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected reservation");
    await releaseReservation(first.reservation.reservationId);
    await releaseReservation(first.reservation.reservationId);
    await expect(reserveCapacity(request)).rejects.toMatchObject({
      code: "INACTIVE_RESERVATION",
    });
    const next = input();
    expect((await reserveCapacity(next)).ok).toBe(true);
    await getPool().query(
      "update reservations set expires_at=now()-interval '1 second' where action_key=$1",
      [next.actionKey],
    );
    expect(await expireReservations()).toBe(1);
    expect(await expireReservations()).toBe(0);
    await expect(reserveCapacity(next)).rejects.toMatchObject({
      code: "INACTIVE_RESERVATION",
    });
    expect((await reserveCapacity({ ...input(), quantity: 400 })).ok).toBe(
      true,
    );
  });

  it("counts persisted operations and projects events exactly once", async () => {
    const event = {
      eventId: randomUUID(),
      traceId: "metrics",
      orderId: "test-metrics",
      eventType: "recovery.completed",
      source: "orchestrator" as const,
      severity: "INFO" as const,
      ts: new Date().toISOString(),
      payload: {},
    };
    const before = await getOperationsMetrics();
    await persistEvent(event);
    await persistEvent(event);
    const after = await getOperationsMetrics();
    expect(after.eventCount).toBe(before.eventCount + 1);
    expect(after.recoveriesCompleted).toBe(before.recoveriesCompleted + 1);
    expect(
      (
        await getPool().query(
          "select count(*) from network_events where event_id=$1",
          [event.eventId],
        )
      ).rows[0].count,
    ).toBe("1");
    expect(after.orderCount).toBe(0);
    expect(after.committedOrderCount).toBe(0);
  });

  it("scopes demo reset and requires an explicit demo gate", async () => {
    const id = `non-demo:${randomUUID()}`;
    await getPool().query(
      "insert into merchants(merchant_id,name,status) values($1,'Production merchant','offline')",
      [id],
    );
    await resetDemoData();
    expect(
      (
        await getPool().query(
          "select status from merchants where merchant_id=$1",
          [id],
        )
      ).rows[0].status,
    ).toBe("offline");
    process.env.DEMO_MODE = "false";
    await expect(resetDemoData()).rejects.toThrow("DEMO_MODE");
    process.env.DEMO_MODE = "true";
    await getPool().query("delete from merchants where merchant_id=$1", [id]);
  });

  it("counts real session/plan/execution rows without counting missing plans or double counting", async () => {
    await transaction(async (client) => {
      await client.query(
        "create temporary table order_sessions(order_id text,session_json jsonb) on commit drop",
      );
      await client.query(
        "create temporary table production_plans(plan_id text,status text) on commit drop",
      );
      await client.query(
        "create temporary table external_resource_refs(order_id text,kind text) on commit drop",
      );
      await client.query(`insert into order_sessions values
        ('one','{"activePlan":{"status":"VALID","planId":"p1"},"executionReceipt":{"customerOrder":{"orderGid":"gid://order/one"}}}'),
        ('two','{"activePlan":{"status":"UNSAT","planId":"p2"}}'),
        ('three','{"activePlan":{"status":"VALID"}}')`);
      await client.query(
        "insert into production_plans values('p1','VALID'),('p2','UNSAT')",
      );
      await client.query(
        "insert into external_resource_refs values('one','shopify_order'),('four','customer_order'),('two','shopify_product')",
      );
      const metrics = await getOperationsMetrics(client);
      expect(metrics.orderCount).toBe(3);
      expect(metrics.validatedPlanCount).toBe(1);
      expect(metrics.committedOrderCount).toBe(2);
    });
  });

  it("retains numeric event values and materializes capacity analytics on either database", async () => {
    const sample = {
      eventId: randomUUID(),
      traceId: "numeric-test",
      merchantId: "base-goods",
      eventType: "reality.claim.resolved",
      ts: new Date().toISOString(),
      severity: "INFO" as const,
      source: "rox" as const,
      payload: { field: "cap-base-hoodie.capacity", value: 777, unit: "units" },
    };
    await persistEvent(sample);
    await persistEvent(sample);
    expect(
      (
        await getPool().query(
          "select numeric_value,unit from network_events where event_id=$1",
          [sample.eventId],
        )
      ).rows,
    ).toEqual([{ numeric_value: "777", unit: "units" }]);
    expect(
      (
        await getPool().query(
          "select avg_capacity from capability_capacity_1m where capability_id='cap-base-hoodie' order by bucket desc limit 1",
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (await getPool().query("select sum(sample_count) from lead_time_hourly"))
        .rows[0].sum,
    ).toBe("900");
  });

  it("projects prefixed inventory events under their actual capability", async () => {
    await persistEvent({
      eventId: randomUUID(),
      traceId: "inventory-metrics",
      merchantId: "base-goods",
      eventType: "reality.claim.resolved",
      ts: new Date().toISOString(),
      severity: "INFO",
      source: "rox",
      payload: {
        field: "inventory.cap-base-hoodie",
        value: 123,
        unit: "units",
      },
    });
    expect(
      (
        await getPool().query(
          "select capability_id,value from market_metrics where merchant_id='base-goods' and value=123",
        )
      ).rows,
    ).toContainEqual({ capability_id: "cap-base-hoodie", value: "123" });
  });

  it("detects changed applied migrations rather than silently accepting drift", async () => {
    const previous = (
      await getPool().query(
        "select checksum from molecule_migrations where filename='001_core.sql'",
      )
    ).rows[0].checksum;
    try {
      await getPool().query(
        "update molecule_migrations set checksum='changed' where filename='001_core.sql'",
      );
      await expect(migrate()).rejects.toThrow(
        "Applied migration changed: 001_core.sql",
      );
    } finally {
      await getPool().query(
        "update molecule_migrations set checksum=$1 where filename='001_core.sql'",
        [previous],
      );
    }
  });
});
