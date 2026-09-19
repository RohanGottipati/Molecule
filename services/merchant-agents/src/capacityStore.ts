/**
 * Reservation bookkeeping matching the playbook's T7 `reservations` table
 * shape (merchantId, capabilityId, orderId, quantity, expiresAt, status,
 * actionKey) and its concurrency contract: reserveCapacity runs as one
 * atomic step so simultaneous orders cannot overbook, and a duplicate
 * actionKey returns the existing reservation instead of creating a second
 * one. packages/db doesn't exist yet, so this is the in-memory
 * implementation of that contract; a Tiger-backed store can replace it
 * without changing the tool handlers that depend on CapacityStore.
 */
export interface CapacityReservation {
  reservationId: string;
  merchantId: string;
  capabilityId: string;
  orderId: string;
  quantity: number;
  status: "held" | "released";
  actionKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveCapacityInput {
  traceId?: string;
  merchantId: string;
  capabilityId: string;
  orderId: string;
  quantity: number;
  actionKey: string;
}

export interface ReleaseCapacityInput {
  traceId?: string;
  merchantId: string;
  capabilityId: string;
  reservationId: string;
  actionKey: string;
}

export class InsufficientCapacityError extends Error {
  constructor(
    public readonly merchantId: string,
    public readonly capabilityId: string,
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(
      `Insufficient capacity for ${merchantId}/${capabilityId}: requested ${requested}, available ${available}`,
    );
    this.name = "InsufficientCapacityError";
  }
}

export interface CapacityStore {
  /** Maximum capacity for (merchantId, capabilityId) minus currently-held reservations. */
  getAvailableCapacity(
    merchantId: string,
    capabilityId: string,
  ): Promise<number>;
  reserve(input: ReserveCapacityInput): Promise<CapacityReservation>;
  release(input: ReleaseCapacityInput): Promise<CapacityReservation>;
}

export class InMemoryCapacityStore implements CapacityStore {
  private readonly totalByCapability = new Map<string, number>();
  private readonly reservationsByActionKey = new Map<
    string,
    CapacityReservation
  >();
  private readonly reservationsById = new Map<string, CapacityReservation>();
  private idSeq = 0;

  private capabilityKey(merchantId: string, capabilityId: string): string {
    return `${merchantId}::${capabilityId}`;
  }

  seedCapacity(merchantId: string, capabilityId: string, total: number): void {
    this.totalByCapability.set(
      this.capabilityKey(merchantId, capabilityId),
      total,
    );
  }

  /**
   * Synchronous on purpose: reserve() calls this directly (no `await` in
   * between reading it and writing the new reservation) so a check-then-set
   * never straddles a microtask boundary. That's what makes reserve()
   * equivalent to the row/advisory-locked transaction T7 asks for even
   * though this store is plain in-memory state — two reserve() calls issued
   * back-to-back cannot interleave mid-check the way they could if this were
   * awaited.
   */
  private computeAvailableCapacity(
    merchantId: string,
    capabilityId: string,
  ): number {
    const total =
      this.totalByCapability.get(
        this.capabilityKey(merchantId, capabilityId),
      ) ?? 0;
    let held = 0;
    for (const reservation of this.reservationsById.values()) {
      if (
        reservation.merchantId === merchantId &&
        reservation.capabilityId === capabilityId &&
        reservation.status === "held"
      ) {
        held += reservation.quantity;
      }
    }
    return total - held;
  }

  async getAvailableCapacity(
    merchantId: string,
    capabilityId: string,
  ): Promise<number> {
    return this.computeAvailableCapacity(merchantId, capabilityId);
  }

  async reserve(input: ReserveCapacityInput): Promise<CapacityReservation> {
    const existing = this.reservationsByActionKey.get(input.actionKey);
    if (existing) {
      return existing;
    }

    const available = this.computeAvailableCapacity(
      input.merchantId,
      input.capabilityId,
    );
    if (input.quantity > available) {
      throw new InsufficientCapacityError(
        input.merchantId,
        input.capabilityId,
        input.quantity,
        available,
      );
    }

    const now = new Date().toISOString();
    const reservation: CapacityReservation = {
      reservationId: `res_${++this.idSeq}`,
      merchantId: input.merchantId,
      capabilityId: input.capabilityId,
      orderId: input.orderId,
      quantity: input.quantity,
      status: "held",
      actionKey: input.actionKey,
      createdAt: now,
      updatedAt: now,
    };
    this.reservationsByActionKey.set(input.actionKey, reservation);
    this.reservationsById.set(reservation.reservationId, reservation);
    return reservation;
  }

  async release(input: ReleaseCapacityInput): Promise<CapacityReservation> {
    const existingForAction = this.reservationsByActionKey.get(input.actionKey);
    if (existingForAction) {
      return existingForAction;
    }

    const reservation = this.reservationsById.get(input.reservationId);
    if (
      !reservation ||
      reservation.merchantId !== input.merchantId ||
      reservation.capabilityId !== input.capabilityId
    ) {
      throw new Error(
        `No reservation ${input.reservationId} for ${input.merchantId}/${input.capabilityId}`,
      );
    }

    const released: CapacityReservation = {
      ...reservation,
      status: "released",
      actionKey: input.actionKey,
      updatedAt: new Date().toISOString(),
    };
    this.reservationsById.set(released.reservationId, released);
    this.reservationsByActionKey.set(input.actionKey, released);
    return released;
  }
}
