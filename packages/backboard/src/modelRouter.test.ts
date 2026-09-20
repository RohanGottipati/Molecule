import { MoleculeEventSchema } from "@molecule/contracts";
import { describe, expect, it, vi } from "vitest";

import { createModelRouter } from "./modelRouter.js";
import { MockBackboardAdapter } from "./MockBackboardAdapter.js";

describe("createModelRouter", () => {
  it("shares in-flight discovery but retries after a transient provider failure", async () => {
    const adapter = new MockBackboardAdapter();
    const spy = vi
      .spyOn(adapter, "listModels")
      .mockRejectedValueOnce(new Error("unavailable"));
    const router = createModelRouter(adapter);
    const failed = await Promise.allSettled([
      router.discoverModels(),
      router.discoverModels(),
    ]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await router.discoverModels()).not.toHaveLength(0);
    await router.discoverModels();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("discovers models once and caches the result across multiple selections", async () => {
    const adapter = new MockBackboardAdapter();
    const spy = vi.spyOn(adapter, "listModels");
    const router = createModelRouter(adapter);

    await router.selectModel({
      task: { kind: "low_stakes_inventory" },
      traceId: "t1",
    });
    await router.selectModel({
      task: { kind: "policy_conflict" },
      traceId: "t2",
    });
    await router.discoverModels();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("routes low-stakes inventory to FAST_OPS", async () => {
    const router = createModelRouter(new MockBackboardAdapter());
    const { selection } = await router.selectModel({
      task: { kind: "low_stakes_inventory" },
      traceId: "t1",
    });
    expect(selection.lane).toBe("FAST_OPS");
    expect(selection.modelId).toBe("mock-fast-1");
  });

  it("routes a policy conflict and a deadline guarantee to HIGH_REASONING", async () => {
    const router = createModelRouter(new MockBackboardAdapter());

    const conflict = await router.selectModel({
      task: { kind: "policy_conflict" },
      traceId: "t1",
    });
    const deadline = await router.selectModel({
      task: { kind: "deadline_guarantee" },
      traceId: "t2",
    });

    expect(conflict.selection.lane).toBe("HIGH_REASONING");
    expect(deadline.selection.lane).toBe("HIGH_REASONING");
    expect(conflict.selection.modelId).toBe("mock-reasoning-1");
    expect(deadline.selection.modelId).toBe("mock-reasoning-1");
  });

  it("routes a visual merchant artifact to VISION_OPTIONAL", async () => {
    const router = createModelRouter(new MockBackboardAdapter());
    const { selection } = await router.selectModel({
      task: { kind: "visual_merchant_artifact" },
      traceId: "t1",
    });
    expect(selection.lane).toBe("VISION_OPTIONAL");
    expect(selection.modelId).toBe("mock-vision-1");
  });

  it("routes bulk extraction to BULK_EXTRACTION using a large-context model", async () => {
    const router = createModelRouter(new MockBackboardAdapter());
    const { selection } = await router.selectModel({
      task: { kind: "bulk_extraction" },
      traceId: "t1",
    });
    expect(selection.lane).toBe("BULK_EXTRACTION");
    expect(selection.modelId).toBe("mock-reasoning-1");
  });

  it("lets a pinned lane override discovery, e.g. at demo freeze", async () => {
    const router = createModelRouter(new MockBackboardAdapter());
    router.pinLane("FAST_OPS", "pinned-demo-model");

    const { selection } = await router.selectModel({
      task: { kind: "low_stakes_inventory" },
      traceId: "t1",
    });
    expect(selection.modelId).toBe("pinned-demo-model");

    // Discovery metadata itself is still available even with a pin in place.
    const models = await router.discoverModels();
    expect(models.map((model) => model.modelId)).toContain("mock-fast-1");
  });

  it("does not route deadline quotes to a thinking model that cannot emit JSON", async () => {
    const router = createModelRouter({
      listModels: async () => [
        {
          modelId: "thinking-only",
          provider: "test",
          supportsTools: true,
          supportsThinking: true,
          supportsJsonOutput: false,
          supportsVision: false,
          contextWindow: 128_000,
        },
      ],
    });
    await expect(
      router.selectModel({
        task: { kind: "deadline_guarantee" },
        traceId: "t1",
      }),
    ).rejects.toThrow(/HIGH_REASONING/i);
  });

  it("throws when no discovered model satisfies a lane and none is pinned", async () => {
    const emptyAdapter: Pick<
      InstanceType<typeof MockBackboardAdapter>,
      "listModels"
    > = {
      listModels: async () => [],
    };
    const router = createModelRouter(emptyAdapter);

    await expect(
      router.selectModel({
        task: { kind: "low_stakes_inventory" },
        traceId: "t1",
      }),
    ).rejects.toThrow(/no discovered backboard model/i);
  });

  it("emits a contract-valid agent.model.selected event with lane/model/reason", async () => {
    const events: unknown[] = [];
    const router = createModelRouter(new MockBackboardAdapter(), {
      emitEvent: (event) => events.push(event),
    });

    const { event, selection } = await router.selectModel({
      task: { kind: "deadline_guarantee" },
      traceId: "trace-1",
      merchantId: "stitchworks",
      orderId: "order-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(event);
    expect(() => MoleculeEventSchema.parse(event)).not.toThrow();
    expect(event.eventType).toBe("agent.model.selected");
    expect(event.source).toBe("backboard");
    expect(event.traceId).toBe("trace-1");
    expect(event.merchantId).toBe("stitchworks");
    expect(event.orderId).toBe("order-1");
    expect(event.payload).toEqual({
      lane: selection.lane,
      modelId: selection.modelId,
      reason: selection.reason,
    });
  });
});
