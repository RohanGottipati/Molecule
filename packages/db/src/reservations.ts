import { MerchantCapabilitySchema } from "@molecule/contracts";

import { transaction } from "./client.js";
import { effectId, persistEvent } from "./operations.js";

export interface ReserveCapacityInput {
  merchantId: string;
  capabilityId: string;
  orderId: string;
  quantity: number;
  actionKey: string;
  traceId?: string;
  ttlSeconds?: number;
}

export interface Reservation {
  reservationId: string;
  merchantId: string;
  capabilityId: string;
  orderId: string;
  quantity: number;
  status: "active" | "released" | "expired";
  actionKey: string;
  expiresAt: string;
  createdAt: string;
}

interface ReservationRow {
  reservation_id: string;
  merchant_id: string;
  capability_id: string;
  order_id: string;
  quantity: string;
  status: Reservation["status"];
  action_key: string;
  expires_at: Date;
  created_at: Date;
  ttl_seconds: number;
  trace_id: string | null;
}

function fromRow(row: ReservationRow): Reservation {
  return {
    reservationId: row.reservation_id,
    merchantId: row.merchant_id,
    capabilityId: row.capability_id,
    orderId: row.order_id,
    quantity: Number(row.quantity),
    status: row.status,
    actionKey: row.action_key,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export class ReservationError extends Error {
  constructor(
    public readonly code:
      | "INVALID_REQUEST"
      | "ACTION_KEY_MISMATCH"
      | "INACTIVE_RESERVATION"
      | "UNKNOWN_CAPABILITY"
      | "OWNERSHIP_MISMATCH"
      | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ReservationError";
  }
}

export async function reserveCapacity(
  input: ReserveCapacityInput,
): Promise<
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: "insufficient_capacity"; available: number }
> {
  const ttl = input.ttlSeconds ?? 1800;
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity <= 0 ||
    !Number.isInteger(ttl) ||
    ttl <= 0 ||
    ttl > 86400 ||
    (input.traceId !== undefined &&
      (typeof input.traceId !== "string" || !input.traceId.trim())) ||
    [input.merchantId, input.capabilityId, input.orderId, input.actionKey].some(
      (value) => typeof value !== "string" || !value.trim(),
    )
  ) {
    throw new ReservationError(
      "INVALID_REQUEST",
      "Positive integral quantity, bounded TTL and identifiers are required",
    );
  }
  await expireReservations();
  return transaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `reservation:${input.actionKey}`,
    ]);
    const existing = (
      await client.query<ReservationRow>(
        "select * from reservations where action_key=$1 for update",
        [input.actionKey],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.merchant_id !== input.merchantId ||
        existing.capability_id !== input.capabilityId ||
        existing.order_id !== input.orderId ||
        Number(existing.quantity) !== input.quantity ||
        existing.ttl_seconds !== ttl
      ) {
        throw new ReservationError(
          "ACTION_KEY_MISMATCH",
          "Reservation actionKey was used with different inputs",
        );
      }
      if (
        existing.status !== "active" ||
        existing.expires_at.getTime() <= Date.now()
      ) {
        throw new ReservationError(
          "INACTIVE_RESERVATION",
          "Use a new actionKey for a released or expired hold",
        );
      }
      return { ok: true, reservation: fromRow(existing) };
    }
    const merchant = (
      await client.query<{ status: string }>(
        "select status from merchants where merchant_id=$1 for update",
        [input.merchantId],
      )
    ).rows[0];
    const row = (
      await client.query<{ merchant_id: string; capability_json: unknown }>(
        "select merchant_id,capability_json from capabilities where capability_id=$1 for update",
        [input.capabilityId],
      )
    ).rows[0];
    if (!row)
      throw new ReservationError("UNKNOWN_CAPABILITY", "Unknown capability");
    if (row.merchant_id !== input.merchantId)
      throw new ReservationError(
        "OWNERSHIP_MISMATCH",
        "Capability does not belong to merchant",
      );
    if (merchant?.status !== "online")
      throw new ReservationError("UNAVAILABLE", "Merchant is not online");
    const capability = MerchantCapabilitySchema.parse(row.capability_json);
    const facts = await client.query<{
      field: string;
      status: string;
      value: unknown;
    }>(
      "select field,status,value from canonical_resolutions where merchant_id=$1",
      [input.merchantId],
    );
    let maximum = capability.capacity.available;
    for (const fact of facts.rows) {
      if (
        ![
          `${input.capabilityId}.capacity`,
          `${input.capabilityId}.capacity_per_day`,
          `${input.capabilityId}.inventory`,
          "capacity_per_day",
          "capacity",
          "inventory",
        ].includes(fact.field)
      )
        continue;
      if (fact.status !== "resolved" || typeof fact.value !== "number") {
        throw new ReservationError(
          "UNAVAILABLE",
          "Capacity or inventory is unresolved",
        );
      }
      maximum = Math.min(maximum ?? fact.value, fact.value);
    }
    if (maximum === undefined)
      throw new ReservationError("UNAVAILABLE", "Capacity is unknown");
    if (
      input.quantity < capability.quantity.min ||
      input.quantity > capability.quantity.max
    ) {
      throw new ReservationError(
        "INVALID_REQUEST",
        "Quantity outside capability range",
      );
    }
    const expired = await client.query<ReservationRow>(
      `update reservations set status='expired' where capability_id=$1 and status='active'
        and expires_at<=now() returning *`,
      [input.capabilityId],
    );
    for (const hold of expired.rows) {
      await persistEvent(
        {
          eventId: effectId(`reservation:expired:${hold.reservation_id}`),
          traceId: hold.trace_id ?? hold.action_key,
          orderId: hold.order_id,
          merchantId: hold.merchant_id,
          eventType: "capacity.reservation.expired",
          ts: new Date().toISOString(),
          severity: "INFO",
          source: "tiger",
          payload: { reservationId: hold.reservation_id },
        },
        client,
      );
    }
    const reserved = await client.query<{ total: string }>(
      "select coalesce(sum(quantity),0) as total from reservations where capability_id=$1 and status='active' and expires_at>now()",
      [input.capabilityId],
    );
    const available = Math.max(
      0,
      maximum - Number(reserved.rows[0]?.total ?? 0),
    );
    if (input.quantity > available)
      return { ok: false, reason: "insufficient_capacity", available };
    const inserted = (
      await client.query<ReservationRow>(
        `insert into reservations(merchant_id,capability_id,order_id,quantity,action_key,ttl_seconds,trace_id,expires_at)
        values($1,$2,$3,$4,$5,$6::integer,$7,now()+$6::integer*interval '1 second') returning *`,
        [
          input.merchantId,
          input.capabilityId,
          input.orderId,
          input.quantity,
          input.actionKey,
          ttl,
          input.traceId ?? input.actionKey,
        ],
      )
    ).rows[0];
    if (!inserted) throw new Error("Reservation insert returned no row");
    await persistEvent(
      {
        eventId: effectId(`reservation:${input.actionKey}`),
        traceId: input.traceId ?? input.actionKey,
        orderId: input.orderId,
        merchantId: input.merchantId,
        eventType: "capacity.reservation.created",
        ts: inserted.created_at.toISOString(),
        severity: "INFO",
        source: "tiger",
        payload: {
          actionKey: input.actionKey,
          reservationId: inserted.reservation_id,
          quantity: input.quantity,
        },
      },
      client,
    );
    return { ok: true, reservation: fromRow(inserted) };
  });
}

export async function expireReservations(): Promise<number> {
  return transaction(async (client) => {
    const expired =
      await client.query<ReservationRow>(`update reservations set status='expired'
      where reservation_id in(select reservation_id from reservations
        where status='active' and expires_at<=now() for update skip locked)
      returning *`);
    for (const row of expired.rows) {
      await persistEvent(
        {
          eventId: effectId(`reservation:expired:${row.reservation_id}`),
          traceId: row.trace_id ?? row.action_key,
          orderId: row.order_id,
          merchantId: row.merchant_id,
          eventType: "capacity.reservation.expired",
          ts: new Date().toISOString(),
          severity: "INFO",
          source: "tiger",
          payload: { reservationId: row.reservation_id },
        },
        client,
      );
    }
    return expired.rowCount ?? 0;
  });
}

export async function releaseReservation(
  reservationId: string,
  traceId?: string,
): Promise<void> {
  await transaction(async (client) => {
    const row = (
      await client.query<ReservationRow>(
        "update reservations set status='released' where reservation_id=$1 and status='active' returning *",
        [reservationId],
      )
    ).rows[0];
    if (!row) return;
    await persistEvent(
      {
        eventId: effectId(`reservation:release:${reservationId}`),
        traceId: traceId ?? row.trace_id ?? row.action_key,
        orderId: row.order_id,
        merchantId: row.merchant_id,
        eventType: "capacity.reservation.released",
        ts: new Date().toISOString(),
        severity: "INFO",
        source: "tiger",
        payload: { reservationId },
      },
      client,
    );
  });
}
