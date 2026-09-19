import { EventEmitter } from "node:events";

import { MoleculeEventSchema, type MoleculeEvent } from "@molecule/contracts";
import { getPool, type DbClient } from "@molecule/db";

// In-process broadcaster. services/orchestrator's SSE route subscribes here
// after calling appendEvent, so the persisted row is always what's replayed
// on reconnect (per docs/ARCHITECTURE.md: "the database event log is the
// source of truth for replay and UI reconnection").
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function subscribe(listener: (event: MoleculeEvent) => void): () => void {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

interface EventRow {
  event_id: string;
  trace_id: string;
  order_id: string | null;
  plan_id: string | null;
  merchant_id: string | null;
  event_type: string;
  severity: MoleculeEvent["severity"];
  source: MoleculeEvent["source"];
  ts: Date;
  payload: Record<string, unknown>;
}

function rowToEvent(row: EventRow): MoleculeEvent {
  return {
    eventId: row.event_id,
    traceId: row.trace_id,
    orderId: row.order_id ?? undefined,
    planId: row.plan_id ?? undefined,
    merchantId: row.merchant_id ?? undefined,
    eventType: row.event_type,
    severity: row.severity,
    source: row.source,
    ts: row.ts.toISOString(),
    payload: row.payload,
  };
}

/**
 * Validates, persists, and broadcasts a MoleculeEvent in one call. This is
 * the only supported way to emit an event — never write to molecule_events
 * directly and never broadcast without persisting first ("event-everything"
 * invariant in AGENTS.md).
 */
export async function appendEvent(
  event: MoleculeEvent,
  client: DbClient = getPool(),
): Promise<MoleculeEvent> {
  const parsed = MoleculeEventSchema.parse(event);

  await client.query(
    `insert into molecule_events
       (event_id, trace_id, order_id, plan_id, merchant_id, event_type,
        severity, source, ts, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (event_id) do nothing`,
    [
      parsed.eventId,
      parsed.traceId,
      parsed.orderId ?? null,
      parsed.planId ?? null,
      parsed.merchantId ?? null,
      parsed.eventType,
      parsed.severity,
      parsed.source,
      parsed.ts,
      JSON.stringify(parsed.payload),
    ],
  );

  emitter.emit("event", parsed);
  return parsed;
}

/** Full persisted history for an order, oldest first — what a reconnecting UI replays. */
export async function listEventsForOrder(
  orderId: string,
  client: DbClient = getPool(),
): Promise<MoleculeEvent[]> {
  const result = await client.query<EventRow>(
    `select * from molecule_events where order_id = $1 order by ts asc`,
    [orderId],
  );
  return result.rows.map(rowToEvent);
}
