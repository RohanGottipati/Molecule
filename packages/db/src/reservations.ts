import { getPool } from "./client.js";

export interface ReserveCapacityInput {
  merchantId: string;
  capabilityId: string;
  orderId: string;
  quantity: number;
  actionKey: string;
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
}

function rowToReservation(row: ReservationRow): Reservation {
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

/**
 * Transactional, idempotent, concurrency-safe capacity reservation (T7).
 *
 * - Locks the capability row (`select ... for update`) so two concurrent
 *   reservations for the same capability cannot both read stale remaining
 *   capacity and overbook it.
 * - Idempotent on `actionKey`: a retry with the same key returns the
 *   existing reservation instead of creating a second one.
 * - Only `active`, non-expired reservations count against capacity.
 */
export async function reserveCapacity(
  input: ReserveCapacityInput,
): Promise<
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: "insufficient_capacity"; available: number }
> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const existing = await client.query<ReservationRow>(
      `select * from reservations where action_key = $1`,
      [input.actionKey],
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      await client.query("commit");
      return { ok: true, reservation: rowToReservation(existingRow) };
    }

    // Lock the capability so a concurrent reserveCapacity call for the same
    // capability blocks here until this transaction commits or rolls back.
    const capability = await client.query<{ capability_json: { capacity?: { available?: number } } }>(
      `select capability_json from capabilities where capability_id = $1 for update`,
      [input.capabilityId],
    );
    const capabilityRow = capability.rows[0];
    if (!capabilityRow) {
      throw new Error(`Unknown capability: ${input.capabilityId}`);
    }
    const maxAvailable = capabilityRow.capability_json.capacity?.available ?? 0;

    const reservedResult = await client.query<{ total: string | null }>(
      `select sum(quantity) as total from reservations
       where capability_id = $1 and status = 'active' and expires_at > now()`,
      [input.capabilityId],
    );
    const alreadyReserved = Number(reservedResult.rows[0]?.total ?? 0);
    const remaining = maxAvailable - alreadyReserved;

    if (input.quantity > remaining) {
      await client.query("rollback");
      return { ok: false, reason: "insufficient_capacity", available: remaining };
    }

    const ttlSeconds = input.ttlSeconds ?? 60 * 30; // 30 minutes default hold
    const inserted = await client.query<ReservationRow>(
      `insert into reservations
         (merchant_id, capability_id, order_id, quantity, action_key, expires_at)
       values ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval)
       returning *`,
      [
        input.merchantId,
        input.capabilityId,
        input.orderId,
        input.quantity,
        input.actionKey,
        ttlSeconds,
      ],
    );

    await client.query("commit");
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("Reservation insert returned no row");
    }
    return { ok: true, reservation: rowToReservation(row) };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseReservation(reservationId: string): Promise<void> {
  await getPool().query(
    `update reservations set status = 'released' where reservation_id = $1`,
    [reservationId],
  );
}
