import { createHash, randomUUID } from "node:crypto";
import { MoleculeEventSchema, type MoleculeEvent } from "@molecule/contracts";
import { getPool, type DbClient } from "@molecule/db";

export type MerchantProviderMode = "demo" | "live";
export type MerchantEventSink = (event: MoleculeEvent) => Promise<void> | void;
export type MerchantPool = ReturnType<typeof getPool>;

export function actionDigest(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
  return createHash("sha256").update(serialized).digest("hex");
}

export async function transaction<T>(
  pool: MerchantPool,
  key: string,
  operation: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '15s'");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function persistMerchantEvent(
  client: DbClient,
  input: Omit<MoleculeEvent, "eventId" | "ts" | "source" | "severity"> & {
    severity?: MoleculeEvent["severity"];
  },
): Promise<MoleculeEvent> {
  const event = MoleculeEventSchema.parse({
    ...input,
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    source: "backboard",
    severity: input.severity ?? "INFO",
  });
  await client.query(
    `insert into molecule_events
      (event_id, trace_id, order_id, merchant_id, event_type, severity, source, ts, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      event.eventId,
      event.traceId,
      event.orderId,
      event.merchantId,
      event.eventType,
      event.severity,
      event.source,
      event.ts,
      event.payload,
    ],
  );
  return event;
}
