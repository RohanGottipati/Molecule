import { getPool, type DbClient } from "@molecule/db";
import {
  InsufficientCapacityError,
  type CapacityReservation,
  type CapacityStore,
  type ReleaseCapacityInput,
  type ReserveCapacityInput,
} from "./capacityStore.js";
import {
  actionDigest,
  persistMerchantEvent,
  transaction,
  type MerchantEventSink,
} from "./database.js";
import {
  JobNotAcceptedError,
  type AcceptJobInput,
  type DeclineJobInput,
  type JobDecision,
  type JobDecisionStore,
  type UpdateEtaInput,
} from "./jobStore.js";

async function action<T>(
  key: string,
  input: { traceId?: string },
  operation: (client: DbClient) => Promise<T>,
  validate?: (client: DbClient, result: T) => Promise<void>,
): Promise<T> {
  if (!key || !input.traceId)
    throw new Error("Action requires traceId and actionKey");
  const { traceId: _traceId, ...identity } = input;
  const hash = actionDigest(identity);
  return transaction(getPool(), `action:${key}`, async (client) => {
    const prior = await client.query<{ input_hash: string; result: T }>(
      "select input_hash,result from merchant_twin_actions where action_key=$1",
      [key],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].input_hash !== hash)
        throw new Error("Idempotency key conflicts with input");
      await validate?.(client, prior.rows[0].result);
      return prior.rows[0].result;
    }
    const result = await operation(client);
    await validate?.(client, result);
    await client.query(
      "insert into merchant_twin_actions(action_key,input_hash,result) values($1,$2,$3)",
      [key, hash, result],
    );
    return result;
  });
}

async function availableCapacity(
  client: Pick<DbClient, "query">,
  merchantId: string,
  capabilityId: string,
): Promise<number> {
  const capacity = await client.query<{
    maximum: string | null;
    reserved: string;
  }>(
    `select c.capability_json->'capacity'->>'available' as maximum,
      coalesce((select sum(quantity) from reservations r where r.capability_id=c.capability_id
        and r.status='active' and r.expires_at>now()),0)::text as reserved
     from capabilities c where c.merchant_id=$1 and c.capability_id=$2`,
    [merchantId, capabilityId],
  );
  const row = capacity.rows[0];
  if (!row || row.maximum === null) return 0;
  let maximum = Number(row.maximum);
  if (!Number.isFinite(maximum) || maximum < 0) return 0;
  const fields = [
    "capacity",
    "capacity.available",
    "capacity_per_day",
    "inventory",
    "status",
    "offline",
    "available",
  ];
  const claims = await client.query<{
    field: string;
    normalized_value: unknown;
    resolution_status: string;
  }>(
    `select field,normalized_value,resolution_status from canonical_claims
     where merchant_id=$1 and field=any($2::text[]) and resolution_status<>'superseded'`,
    [
      merchantId,
      [...fields, ...fields.map((field) => `${capabilityId}.${field}`)],
    ],
  );
  const values = new Map<string, unknown>();
  for (const claim of claims.rows) {
    if (claim.resolution_status !== "active") return 0;
    if (
      values.has(claim.field) &&
      values.get(claim.field) !== claim.normalized_value
    )
      return 0;
    values.set(claim.field, claim.normalized_value);
    const field = claim.field.startsWith(`${capabilityId}.`)
      ? claim.field.slice(capabilityId.length + 1)
      : claim.field;
    if (field === "status") {
      if (claim.normalized_value !== "online") return 0;
    } else if (field === "offline") {
      if (claim.normalized_value !== false) return 0;
    } else if (field === "available") {
      if (claim.normalized_value !== true) return 0;
    } else {
      if (
        typeof claim.normalized_value !== "number" ||
        !Number.isFinite(claim.normalized_value) ||
        claim.normalized_value < 0
      )
        return 0;
      maximum = Math.min(maximum, claim.normalized_value);
    }
  }
  return Math.max(0, maximum - Number(row.reserved));
}

export class DatabaseCapacityStore implements CapacityStore {
  constructor(private readonly eventSink?: MerchantEventSink) {}

  async getAvailableCapacity(
    merchantId: string,
    capabilityId: string,
  ): Promise<number> {
    return availableCapacity(getPool(), merchantId, capabilityId);
  }

  async reserve(input: ReserveCapacityInput): Promise<CapacityReservation> {
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0)
      throw new Error("Invalid quantity");
    const result = await action(
      input.actionKey,
      input,
      async (client) => {
        const capability = await client.query<{ available: string | null }>(
          `select capability_json->'capacity'->>'available' as available from capabilities
         where merchant_id=$1 and capability_id=$2 for update`,
          [input.merchantId, input.capabilityId],
        );
        if (!capability.rowCount)
          throw new Error("Unknown merchant capability");
        const existing = await client.query<{
          merchant_id: string;
          order_id: string;
          capability_id: string;
          quantity: string;
          reservation_id: string;
          created_at: Date;
          status: string;
        }>("select * from reservations where action_key=$1", [input.actionKey]);
        const prior = existing.rows[0];
        if (
          prior &&
          (prior.merchant_id !== input.merchantId ||
            prior.order_id !== input.orderId ||
            prior.capability_id !== input.capabilityId ||
            Number(prior.quantity) !== input.quantity)
        ) {
          throw new Error("Reservation idempotency conflict");
        }
        const available = await availableCapacity(
          client,
          input.merchantId,
          input.capabilityId,
        );
        if (!prior && available < input.quantity) {
          throw new InsufficientCapacityError(
            input.merchantId,
            input.capabilityId,
            input.quantity,
            available,
          );
        }
        const inserted = prior
          ? undefined
          : await client.query<{
              reservation_id: string;
              created_at: Date;
              status: string;
            }>(
              `insert into reservations(merchant_id,capability_id,order_id,quantity,action_key,expires_at)
         values($1,$2,$3,$4,$5,now()+interval '30 minutes') returning reservation_id,created_at,status`,
              [
                input.merchantId,
                input.capabilityId,
                input.orderId,
                input.quantity,
                input.actionKey,
              ],
            );
        const held = prior ?? inserted?.rows[0];
        if (!held) throw new Error("Reservation insert failed");
        const reservation: CapacityReservation = {
          merchantId: input.merchantId,
          capabilityId: input.capabilityId,
          orderId: input.orderId,
          quantity: input.quantity,
          actionKey: input.actionKey,
          reservationId: held.reservation_id,
          status: held.status === "active" ? "held" : "released",
          createdAt: held.created_at.toISOString(),
          updatedAt: held.created_at.toISOString(),
        };
        const event = await persistMerchantEvent(client, {
          eventType: "merchant.capacity.reserved",
          traceId: input.traceId!,
          orderId: input.orderId,
          merchantId: input.merchantId,
          payload: {
            actionKey: input.actionKey,
            reservationId: reservation.reservationId,
          },
        });
        return { reservation, event };
      },
      async (client, result) => {
        const held = await client.query(
          "select 1 from reservations where reservation_id=$1 and status='active' and expires_at>now() for update",
          [result.reservation.reservationId],
        );
        if (!held.rowCount)
          throw new Error("Inactive reservation; use a new actionKey");
      },
    );
    await this.eventSink?.(result.event);
    return result.reservation;
  }

  async release(input: ReleaseCapacityInput): Promise<CapacityReservation> {
    const result = await action(input.actionKey, input, async (client) => {
      const rows = await client.query<{
        reservation_id: string;
        order_id: string;
        quantity: string;
        created_at: Date;
      }>(
        `update reservations set status='released'
         where reservation_id=$1 and merchant_id=$2 and capability_id=$3
         returning reservation_id,order_id,quantity,created_at`,
        [input.reservationId, input.merchantId, input.capabilityId],
      );
      const row = rows.rows[0];
      if (!row) throw new Error("Unknown merchant reservation");
      const reservation: CapacityReservation = {
        ...input,
        orderId: row.order_id,
        quantity: Number(row.quantity),
        status: "released",
        createdAt: row.created_at.toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const event = await persistMerchantEvent(client, {
        eventType: "merchant.capacity.released",
        traceId: input.traceId!,
        orderId: row.order_id,
        merchantId: input.merchantId,
        payload: {
          actionKey: input.actionKey,
          reservationId: input.reservationId,
        },
      });
      return { reservation, event };
    });
    await this.eventSink?.(result.event);
    return result.reservation;
  }
}

export class DatabaseJobDecisionStore implements JobDecisionStore {
  constructor(private readonly eventSink?: MerchantEventSink) {}

  async getDecision(
    merchantId: string,
    orderId: string,
    nodeId: string,
  ): Promise<JobDecision | undefined> {
    const result = await getPool().query<{ record: JobDecision }>(
      "select record from merchant_twin_jobs where merchant_id=$1 and order_id=$2 and node_id=$3",
      [merchantId, orderId, nodeId],
    );
    return result.rows[0]?.record;
  }

  acceptJob(input: AcceptJobInput): Promise<JobDecision> {
    return this.write(input, "accepted");
  }
  declineJob(input: DeclineJobInput): Promise<JobDecision> {
    return this.write(input, "declined");
  }
  updateEta(input: UpdateEtaInput): Promise<JobDecision> {
    return this.write(input, "eta");
  }

  private async write(
    input: AcceptJobInput | DeclineJobInput | UpdateEtaInput,
    kind: "accepted" | "declined" | "eta",
  ): Promise<JobDecision> {
    const actionInput = { ...input, kind };
    const result = await action(
      input.actionKey,
      actionInput,
      async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1,0))",
          [`job:${input.merchantId}:${input.orderId}:${input.nodeId}`],
        );
        const rows = await client.query<{ record: JobDecision }>(
          "select record from merchant_twin_jobs where merchant_id=$1 and order_id=$2 and node_id=$3",
          [input.merchantId, input.orderId, input.nodeId],
        );
        const prior = rows.rows[0]?.record;
        if (kind === "eta" && prior?.status !== "accepted")
          throw new JobNotAcceptedError(input.orderId, input.nodeId);
        const decision: JobDecision = {
          merchantId: input.merchantId,
          orderId: input.orderId,
          nodeId: input.nodeId,
          status: kind === "eta" ? "accepted" : kind,
          eta: "eta" in input ? input.eta : undefined,
          reason: "reason" in input ? input.reason : undefined,
          actionKey: input.actionKey,
          updatedAt: new Date().toISOString(),
        };
        await client.query(
          `insert into merchant_twin_jobs(merchant_id,order_id,node_id,record) values($1,$2,$3,$4)
         on conflict(merchant_id,order_id,node_id) do update set record=excluded.record`,
          [input.merchantId, input.orderId, input.nodeId, decision],
        );
        const event = await persistMerchantEvent(client, {
          eventType: `merchant.job.${kind}`,
          traceId: input.traceId!,
          orderId: input.orderId,
          merchantId: input.merchantId,
          payload: { ...decision },
        });
        return { decision, event };
      },
    );
    await this.eventSink?.(result.event);
    return result.decision;
  }
}
