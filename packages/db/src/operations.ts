import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  CandidateRiskSchema,
  MoleculeEventSchema,
  OperationsMetricsSchema,
  type MoleculeEvent,
  type OperationsMetrics,
} from "@molecule/contracts";

import { getPool, type DbClient } from "./client.js";

export function effectId(actionKey: string): string {
  const hash = createHash("sha256").update(actionKey).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export interface PersistedEvent {
  cursor: number;
  event: MoleculeEvent;
}

interface EventRow {
  cursor: string;
  event_id: string;
  trace_id: string;
  order_id: string | null;
  plan_id: string | null;
  merchant_id: string | null;
  event_type: string;
  severity: string;
  source: string;
  ts: Date;
  payload: unknown;
}

function eventFromRow(row: EventRow): PersistedEvent {
  const cursor = Number(row.cursor);
  if (!Number.isSafeInteger(cursor))
    throw new Error("Event cursor exceeds safe integer range");
  return {
    cursor,
    event: MoleculeEventSchema.parse({
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
    }),
  };
}

export async function persistEvent(
  event: MoleculeEvent,
  client: DbClient = getPool(),
): Promise<PersistedEvent> {
  const parsed = MoleculeEventSchema.parse(event);
  parsed.ts = new Date(parsed.ts).toISOString();
  const result = await client.query<EventRow>(
    `insert into molecule_events(event_id,trace_id,order_id,plan_id,merchant_id,event_type,severity,source,ts,payload)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(event_id) do nothing returning *`,
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
  const row =
    result.rows[0] ??
    (
      await client.query<EventRow>(
        "select * from molecule_events where event_id=$1",
        [parsed.eventId],
      )
    ).rows[0];
  if (!row) throw new Error("Event insert returned no row");
  const persisted = eventFromRow(row);
  if (
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(persisted.event)),
      JSON.parse(JSON.stringify(parsed)),
    )
  ) {
    throw new Error("Event idempotency mismatch");
  }
  return persisted;
}

export async function readEvents(
  options: { afterCursor?: number; orderId?: string; limit?: number } = {},
  client: DbClient = getPool(),
): Promise<PersistedEvent[]> {
  const cursor = options.afterCursor ?? 0;
  const limit = options.limit ?? 1000;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10000
  ) {
    throw new Error("Invalid event cursor or limit");
  }
  const result = await client.query<EventRow>(
    `select * from molecule_events where cursor > $1 and ($2::text is null or order_id=$2)
      order by cursor limit $3`,
    [cursor, options.orderId ?? null, limit],
  );
  return result.rows.map(eventFromRow);
}

export async function getRecentEvents(
  limit = 50,
  client: DbClient = getPool(),
): Promise<MoleculeEvent[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Invalid event limit");
  const rows = await client.query<EventRow>(
    "select * from molecule_events order by cursor desc limit $1",
    [limit],
  );
  return rows.rows.map((row) => eventFromRow(row).event);
}

export async function getMerchantRisk(
  merchantId: string,
  capabilityId: string,
  client: DbClient = getPool(),
) {
  const result = await client.query<{
    p50_hours: number;
    p95_hours: number;
    p99_hours: number;
    sample_count: string;
  }>("select * from merchant_risk where merchant_id=$1 and capability_id=$2", [
    merchantId,
    capabilityId,
  ]);
  const row = result.rows[0];
  const count = Number(row?.sample_count ?? 0);
  return CandidateRiskSchema.parse({
    p50Hours: row?.p50_hours,
    p95Hours: row?.p95_hours,
    p99Hours: row?.p99_hours,
    sampleCount: count,
    confidence: count >= 100 ? "high" : count >= 20 ? "medium" : "low",
  });
}

export async function getDatabaseFeatures(client: DbClient = getPool()) {
  const result = await client.query<{
    name: string;
    available: boolean;
    detail: string;
  }>(
    `select f.name, exists(select 1 from pg_extension e where e.extname=f.name) as available,
      f.detail from database_features f order by f.name`,
  );
  return { extensions: result.rows, candidateSearch: "lexical" as const };
}

export async function getOperationsMetrics(
  client: DbClient = getPool(),
): Promise<OperationsMetrics> {
  const hasSessions = await client.query<{ relation: string | null }>(
    "select to_regclass('order_sessions') as relation",
  );
  const sessions = hasSessions.rows[0]?.relation
    ? "select order_id,session_json from order_sessions"
    : "select null::text as order_id,null::jsonb as session_json where false";
  const counts = await client.query<{
    orders: string;
    plans: string;
    committed: string;
    events: string;
    reservations: string;
    conflicts: string;
    recoveries: string;
  }>(`with sessions as (${sessions})
    select
    (select count(*) from sessions) as orders,
    (select count(*) from (
      select plan_id from production_plans where status='VALID'
      union select session_json #>> '{activePlan,planId}' from sessions
        where session_json #>> '{activePlan,status}'='VALID'
          and session_json #>> '{activePlan,planId}' is not null
    ) p) as plans,
    (select count(*) from (
      select order_id from sessions where session_json #>> '{executionReceipt,customerOrder,orderGid}' is not null
        or session_json #>> '{executionReceipt,customerOrder,draftOrderGid}' is not null
      union select order_id from external_resource_refs where kind in ('shopify_order','customer_order')
    ) c) as committed,
    (select count(*) from molecule_events) as events,
    (select count(*) from reservations where status='active' and expires_at>now()) as reservations,
    (select count(*) from canonical_resolutions where status='conflicted') as conflicts,
    (select count(*) from molecule_events where event_type in
      ('recovery.completed','order.recovery.completed','orchestrator.recovery.completed')) as recoveries`);
  const row = counts.rows[0];
  const events = await client.query<{ event_type: string; count: string }>(
    "select event_type,count(*) from network_events group by event_type order by event_type",
  );
  return OperationsMetricsSchema.parse({
    orderCount: Number(row?.orders ?? 0),
    validatedPlanCount: Number(row?.plans ?? 0),
    committedOrderCount: Number(row?.committed ?? 0),
    eventCount: Number(row?.events ?? 0),
    reservationCount: Number(row?.reservations ?? 0),
    conflictCount: Number(row?.conflicts ?? 0),
    recoveriesCompleted: Number(row?.recoveries ?? 0),
    eventCounts: events.rows.map((event) => ({
      eventType: event.event_type,
      count: Number(event.count),
    })),
  });
}
