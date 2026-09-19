import { describe, expect, it } from "vitest";
import { InMemoryCapacityStore } from "./capacityStore.js";
import { InMemoryJobDecisionStore } from "./jobStore.js";

const reserve = {
  merchantId: "merchant",
  capabilityId: "cap",
  orderId: "order",
  quantity: 2,
  actionKey: "reserve",
};
const job = {
  merchantId: "merchant",
  orderId: "order",
  nodeId: "node",
  actionKey: "job",
};

describe("in-memory mutation parity", () => {
  it("rejects changed reservation identity, quantity and cross-operation action keys", async () => {
    const store = new InMemoryCapacityStore();
    store.seedCapacity("merchant", "cap", 10);
    const first = await store.reserve(reserve);
    expect(await store.reserve({ ...reserve, traceId: "retry" })).toEqual(
      first,
    );
    for (const change of [
      { quantity: 3 },
      { merchantId: "other" },
      { capabilityId: "other" },
      { orderId: "other" },
    ]) {
      await expect(store.reserve({ ...reserve, ...change })).rejects.toThrow(
        /idempotency/i,
      );
    }
    await expect(
      store.release({ ...reserve, reservationId: first.reservationId }),
    ).rejects.toThrow(/idempotency/i);
    const release = {
      ...reserve,
      reservationId: first.reservationId,
      actionKey: "release",
    };
    const released = await store.release(release);
    expect(await store.release(release)).toEqual(released);
    await expect(
      store.release({ ...release, reservationId: "other" }),
    ).rejects.toThrow(/idempotency/i);
    expect(await store.getAvailableCapacity("merchant", "cap")).toBe(10);
    await expect(store.reserve(reserve)).rejects.toThrow(/inactive/i);
  });

  it.each([0, -1, 0.5, NaN, Infinity])(
    "rejects invalid reservation quantity %s",
    async (quantity) => {
      const store = new InMemoryCapacityStore();
      store.seedCapacity("merchant", "cap", 10);
      await expect(store.reserve({ ...reserve, quantity })).rejects.toThrow(
        /quantity/i,
      );
      expect(await store.getAvailableCapacity("merchant", "cap")).toBe(10);
    },
  );

  it("rejects changed job inputs and action-key reuse between accept, decline and ETA", async () => {
    const store = new InMemoryJobDecisionStore();
    const accepted = await store.acceptJob(job);
    expect(await store.acceptJob({ ...job, traceId: "retry" })).toEqual(
      accepted,
    );
    await expect(store.acceptJob({ ...job, nodeId: "other" })).rejects.toThrow(
      /idempotency/i,
    );
    await expect(
      store.acceptJob({ ...job, eta: "2026-10-01T00:00:00.000Z" }),
    ).rejects.toThrow(/idempotency/i);
    await expect(
      store.declineJob({ ...job, reason: "offline" }),
    ).rejects.toThrow(/idempotency/i);
    const eta = { ...job, eta: "2026-10-01T00:00:00.000Z", actionKey: "eta" };
    const updated = await store.updateEta(eta);
    expect(await store.updateEta(eta)).toEqual(updated);
    await expect(
      store.updateEta({ ...eta, eta: "2026-10-02T00:00:00.000Z" }),
    ).rejects.toThrow(/idempotency/i);
    expect(
      await store.getDecision(job.merchantId, job.orderId, job.nodeId),
    ).toEqual(updated);
  });
});
