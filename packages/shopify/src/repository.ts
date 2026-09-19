import { randomUUID } from "node:crypto";
import { MoleculeEventSchema, type MoleculeEvent } from "@molecule/contracts";
import pg from "pg";
import {
  OrderStateSchema,
  ShopifyError,
  type ShopifyOrderState,
} from "./types.js";

export interface OrderJournal {
  load(): Promise<ShopifyOrderState | undefined>;
  save(state: ShopifyOrderState, event: MoleculeEvent): Promise<void>;
}

export interface ShopifyActionRepository {
  withOrder<T>(
    orderId: string,
    run: (journal: OrderJournal) => Promise<T>,
  ): Promise<T>;
  inspect(orderId: string): Promise<ShopifyOrderState | undefined>;
  events(orderId?: string): Promise<MoleculeEvent[]>;
  recordWebhook(
    domain: string,
    deliveryId: string,
    bodyHash: string,
    event: MoleculeEvent,
  ): Promise<"accepted" | "duplicate">;
}

export function eventFor(
  traceId: string,
  eventType: string,
  payload: Record<string, unknown>,
  orderId?: string,
  planId?: string,
): MoleculeEvent {
  return MoleculeEventSchema.parse({
    eventId: randomUUID(),
    traceId,
    orderId,
    planId,
    eventType,
    ts: new Date().toISOString(),
    severity: eventType.endsWith("failed") ? "ERROR" : "INFO",
    source: "shopify",
    payload,
  });
}

export class PostgresShopifyActionRepository implements ShopifyActionRepository {
  constructor(
    private readonly pool: pg.Pool,
    readonly namespace = "shopify",
    private readonly lockTimeoutMs = 5_000,
  ) {
    if (
      !namespace.trim() ||
      !Number.isFinite(lockTimeoutMs) ||
      lockTimeoutMs < 1 ||
      lockTimeoutMs > 60_000
    ) {
      throw new ShopifyError("INVALID_REPOSITORY_CONFIG");
    }
  }

  async withOrder<T>(
    orderId: string,
    run: (journal: OrderJournal) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    const lock = `${this.namespace}:${orderId}`;
    let locked = false;
    let disconnected = false;
    const onError = () => {
      disconnected = true;
    };
    client.on("error", onError);
    try {
      await client.query("SELECT set_config('lock_timeout', $1, false)", [
        `${this.lockTimeoutMs}ms`,
      ]);
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        lock,
      ]);
      locked = true;
      return await run({
        load: async () => {
          const result = await client.query<{ state: unknown }>(
            "SELECT state FROM molecule_shopify_orders WHERE namespace=$1 AND order_id=$2",
            [this.namespace, orderId],
          );
          return result.rows[0]
            ? OrderStateSchema.parse(result.rows[0].state)
            : undefined;
        },
        save: async (state, event) => {
          if (disconnected) throw new ShopifyError("PERSISTENCE_DISCONNECTED");
          const parsed = OrderStateSchema.parse(state);
          const parsedEvent = MoleculeEventSchema.parse(event);
          if (parsed.orderId !== orderId)
            throw new ShopifyError("ORDER_MISMATCH");
          await client.query("BEGIN");
          try {
            await client.query(
              `INSERT INTO molecule_shopify_orders(namespace,order_id,state) VALUES($1,$2,$3)
               ON CONFLICT(namespace,order_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now()`,
              [this.namespace, orderId, JSON.stringify(parsed)],
            );
            await client.query(
              "INSERT INTO molecule_shopify_events(namespace,event_id,order_id,event) VALUES($1,$2,$3,$4)",
              [
                this.namespace,
                parsedEvent.eventId,
                orderId,
                JSON.stringify(parsedEvent),
              ],
            );
            await client.query("COMMIT");
          } catch {
            await client.query("ROLLBACK");
            throw new ShopifyError("PERSISTENCE_FAILED");
          }
        },
      });
    } finally {
      try {
        if (disconnected) throw new ShopifyError("PERSISTENCE_DISCONNECTED");
        if (locked)
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [lock],
          );
        await client.query("RESET lock_timeout");
        client.removeListener("error", onError);
        client.release();
      } catch {
        client.removeListener("error", onError);
        client.release(true);
      }
    }
  }

  async inspect(orderId: string): Promise<ShopifyOrderState | undefined> {
    const result = await this.pool.query<{ state: unknown }>(
      "SELECT state FROM molecule_shopify_orders WHERE namespace=$1 AND order_id=$2",
      [this.namespace, orderId],
    );
    return result.rows[0]
      ? OrderStateSchema.parse(result.rows[0].state)
      : undefined;
  }

  async events(orderId?: string): Promise<MoleculeEvent[]> {
    const result = await this.pool.query<{ event: unknown }>(
      `SELECT event FROM molecule_shopify_events WHERE namespace=$1
       AND ($2::text IS NULL OR order_id=$2) ORDER BY sequence`,
      [this.namespace, orderId ?? null],
    );
    return result.rows.map((row) => MoleculeEventSchema.parse(row.event));
  }

  async recordWebhook(
    domain: string,
    deliveryId: string,
    bodyHash: string,
    event: MoleculeEvent,
  ): Promise<"accepted" | "duplicate"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO molecule_shopify_webhooks(namespace,domain,delivery_id,body_hash)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING delivery_id`,
        [this.namespace, domain, deliveryId, bodyHash],
      );
      if (!result.rowCount) {
        const existing = await client.query<{ body_hash: string }>(
          "SELECT body_hash FROM molecule_shopify_webhooks WHERE namespace=$1 AND domain=$2 AND delivery_id=$3",
          [this.namespace, domain, deliveryId],
        );
        if (existing.rows[0]?.body_hash !== bodyHash)
          throw new ShopifyError("WEBHOOK_REPLAY_CONFLICT");
        await client.query("COMMIT");
        return "duplicate";
      }
      const parsed = MoleculeEventSchema.parse(event);
      await client.query(
        "INSERT INTO molecule_shopify_events(namespace,event_id,order_id,event) VALUES($1,$2,$3,$4)",
        [
          this.namespace,
          parsed.eventId,
          parsed.orderId ?? null,
          JSON.stringify(parsed),
        ],
      );
      await client.query("COMMIT");
      return "accepted";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error instanceof ShopifyError
        ? error
        : new ShopifyError("PERSISTENCE_FAILED");
    } finally {
      client.release();
    }
  }
}

export function connectShopifyRepository(
  connectionString: string,
  namespace = "shopify",
) {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    max: 10,
  });
  return {
    repository: new PostgresShopifyActionRepository(pool, namespace),
    close: () => pool.end(),
  };
}
