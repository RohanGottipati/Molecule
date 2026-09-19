import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool, getPool, migrate } from "@molecule/db";

import {
  appendEvent,
  listEventsForOrder,
  readEvents,
  subscribePersisted,
} from "./index.js";

const database = process.env.TEST_DATABASE_URL;
const execute = promisify(execFile);
const event = (orderId: string, ts = new Date().toISOString()) => ({
  eventId: randomUUID(),
  traceId: "events-test",
  orderId,
  eventType: "test.persisted",
  ts,
  severity: "INFO" as const,
  source: "tiger" as const,
  payload: { message: "visible across processes" },
});

describe.skipIf(!database)("durable event integration", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    await migrate();
  });
  afterAll(closePool);

  it("replays by insertion cursor even when producer timestamps move backwards", async () => {
    const orderId = randomUUID();
    const first = event(orderId, "2026-09-19T00:00:00.000Z");
    const second = event(orderId, "2026-09-18T00:00:00.000Z");
    await appendEvent(first);
    await appendEvent(second);
    const page = await readEvents({ orderId, limit: 1 });
    expect(page[0]?.event).toEqual(first);
    expect(
      (await readEvents({ orderId, afterCursor: page[0]?.cursor })).map(
        (entry) => entry.event,
      ),
    ).toEqual([second]);
    expect(await listEventsForOrder(orderId)).toEqual([first, second]);
    await appendEvent(first);
    await expect(
      appendEvent({ ...first, payload: { changed: true } }),
    ).rejects.toThrow("idempotency mismatch");
    expect(await listEventsForOrder(orderId)).toHaveLength(2);
  });

  it("does not publish rolled-back transactions", async () => {
    const client = await getPool().connect();
    const sample = event(randomUUID());
    try {
      await client.query("begin");
      await appendEvent(sample, client);
      await client.query("rollback");
    } finally {
      client.release();
    }
    expect(await listEventsForOrder(sample.orderId)).toEqual([]);
    expect(
      (
        await getPool().query(
          "select count(*) from network_events where event_id=$1",
          [sample.eventId],
        )
      ).rows[0].count,
    ).toBe("0");
  });

  it("subscribes to commits from another Node process and emits duplicates once", async () => {
    const sample = event(randomUUID());
    const seen: string[] = [];
    const unsubscribe = await subscribePersisted(
      (entry) => {
        seen.push(entry.event.eventId);
      },
      { orderId: sample.orderId, pollMs: 10 },
    );
    try {
      await execute(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {appendEvent} from './dist/index.js';import {closePool} from '@molecule/db';const e=JSON.parse(process.argv[1]);await appendEvent(e);await appendEvent(e);await closePool();`,
          JSON.stringify(sample),
        ],
        { timeout: 10000 },
      );
      await expect
        .poll(() => seen, { timeout: 5000 })
        .toEqual([sample.eventId]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps a commit-ordered cursor when transactions overlap", async () => {
    const orderId = randomUUID();
    const first = event(orderId);
    const second = event(orderId);
    const client = await getPool().connect();
    let pending: Promise<unknown> | undefined;
    try {
      await client.query("begin");
      await appendEvent(first, client);
      pending = appendEvent(second);
      expect(await listEventsForOrder(orderId)).toEqual([]);
      await client.query("commit");
      await pending;
      expect(await listEventsForOrder(orderId)).toEqual([first, second]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
