import { describe, expect, it } from "vitest";
import { MockShopifyClient, RealShopifyClient } from "./client.js";
import { ShopifyError, digest } from "./types.js";
import { FakeShopify, plan, TestRepository } from "../tests/helpers.js";
import type { OrderJournal } from "./repository.js";

describe("durable mock execution", () => {
  it("serializes concurrent retries, persists actual effects, and survives new client instances", async () => {
    const repository = new TestRepository();
    const clients = Array.from(
      { length: 10 },
      () => new MockShopifyClient({ repository }),
    );
    const receipts = await Promise.all(
      clients.map((client) => client.commit(plan(), "trace")),
    );
    for (const receipt of receipts) expect(receipt).toEqual(receipts[0]);
    const state = await repository.inspect(plan().orderId);
    expect(Object.keys(state!.mockResources)).toHaveLength(4);
    expect(receipts[0]!.compositeProduct?.adminUrl).toBeUndefined();
    expect(receipts[0]!.customerOrder?.checkoutUrl).toBeUndefined();
    expect(
      (await repository.events()).every(
        (event) => event.traceId && event.source === "shopify",
      ),
    ).toBe(true);
  });

  it("rejects invalid, UNSAT and untraced plans before persisting effects", async () => {
    const repository = new TestRepository();
    const client = new MockShopifyClient({ repository });
    await expect(
      client.commit(plan({ status: "UNSAT" }), "trace"),
    ).rejects.toThrow("INVALID_PLAN");
    await expect(client.commit(plan({ nodes: [] }), "trace")).rejects.toThrow(
      "INVALID_PLAN",
    );
    await expect(client.commit(plan(), "")).rejects.toThrow("INVALID_PLAN");
    await expect(
      client.commit(plan({ totalCost: 1.001 }), "trace"),
    ).rejects.toThrow("UNSUPPORTED_MONEY_PRECISION");
    expect(await repository.inspect(plan().orderId)).toBeUndefined();
  });

  it("retains partial successes and retries only a known rejected effect", async () => {
    const repository = new TestRepository();
    let fail = true;
    const client = new MockShopifyClient({
      repository,
      beforeEffect: async (effect) => {
        if (effect.nodeId === "embroidery" && fail)
          throw new ShopifyError("TEST_REJECTION");
      },
    });
    const first = await client.commit(plan(), "trace-1");
    expect(first.actions.at(-1)?.status).toBe("FAILED");
    expect(first.supplierJobs).toHaveLength(1);
    expect(first.customerOrder).toBeUndefined();
    fail = false;
    const recovered = await client.reconcile(plan(), "trace-2");
    expect(
      recovered.actions.every((action) => action.status === "SUCCEEDED"),
    ).toBe(true);
    expect(recovered.compositeProduct).toEqual(first.compositeProduct);
    expect(
      Object.keys((await repository.inspect(plan().orderId))!.mockResources),
    ).toHaveLength(4);
  });

  it("supersedes replaced jobs, preserves unchanged jobs and reuses product/customer on recovery", async () => {
    const repository = new TestRepository();
    const client = new MockShopifyClient({ repository });
    const first = await client.commit(plan(), "trace-1");
    const replacement = plan({
      planId: "plan-2",
      nodes: plan().nodes.map((node) =>
        node.nodeId === "embroidery"
          ? { ...node, merchantId: "needle-north" }
          : node,
      ),
    });
    const next = await client.commit(replacement, "trace-2");
    expect(next.compositeProduct?.productGid).toBe(
      first.compositeProduct?.productGid,
    );
    expect(next.customerOrder).toEqual(first.customerOrder);
    expect(next.supplierJobs[0]?.draftOrderGid).toBe(
      first.supplierJobs[0]?.draftOrderGid,
    );
    expect(next.supplierJobs[1]?.draftOrderGid).not.toBe(
      first.supplierJobs[1]?.draftOrderGid,
    );
    const state = (await repository.inspect(plan().orderId))!;
    expect(
      state.mockResources[first.supplierJobs[1]!.draftOrderGid]?.resource
        .status,
    ).toBe("SUPERSEDED");
    expect(Object.keys(state.mockResources)).toHaveLength(5);
    await expect(client.commit(plan(), "stale")).rejects.toThrow(
      "PLAN_SUPERSEDED",
    );
    expect(await client.commit(replacement, "retry")).toEqual(next);
  });

  it("persists reusable jobs through a failed replacement product update", async () => {
    const repository = new TestRepository();
    let fail = false;
    const client = new MockShopifyClient({
      repository,
      beforeEffect: async (effect) => {
        if (fail && effect.operation === "product")
          throw new ShopifyError("TEST_REJECTION");
      },
    });
    const first = await client.commit(plan(), "trace");
    const replacement = plan({ planId: "plan-2", intentVersion: 2 });
    fail = true;
    expect(
      (await client.commit(replacement, "trace")).actions.at(-1)?.status,
    ).toBe("FAILED");
    fail = false;
    const next = await client.commit(replacement, "trace");
    expect(next.supplierJobs).toEqual(first.supplierJobs);
    expect(
      Object.keys((await repository.inspect(plan().orderId))!.mockResources),
    ).toHaveLength(4);
  });

  it("refuses plan-id mutation, older intent versions, and cancellation followed by retries", async () => {
    const repository = new TestRepository();
    const client = new MockShopifyClient({ repository });
    await client.commit(plan({ intentVersion: 2 }), "trace");
    await expect(
      client.commit(plan({ intentVersion: 2, totalCost: 3 }), "trace"),
    ).rejects.toThrow("PLAN_ID_REUSED");
    await expect(
      client.commit(plan({ planId: "old" }), "trace"),
    ).rejects.toThrow("STALE_PLAN");
    const receipt = await client.supersede(
      plan().orderId,
      plan().planId,
      "trace",
    );
    expect(receipt.actions).toHaveLength(2);
    expect(
      receipt.actions.every((action) => action.status === "SUCCEEDED"),
    ).toBe(true);
    await expect(
      client.commit(plan({ intentVersion: 2 }), "trace"),
    ).rejects.toThrow("PLAN_SUPERSEDED");
  });

  it("persists artifact instructions and rejects a reused plan ID with changed instructions", async () => {
    const repository = new TestRepository();
    let asset = "logo-artifact-v1";
    const client = new MockShopifyClient({
      repository,
      jobInstructions: () => ({ artifactId: asset }),
    });
    const first = await client.commit(plan(), "trace");
    const state = (await repository.inspect(plan().orderId))!;
    expect(
      Object.values(state.actions).find(
        (action) => action.effect.nodeId === "embroidery",
      )?.effect.attributes.molecule_instructions,
    ).toContain(asset);
    asset = "logo-artifact-v2";
    await expect(client.commit(plan(), "trace")).rejects.toThrow(
      "PLAN_ID_REUSED",
    );
    const second = await client.commit(
      plan({ planId: "plan-2", intentVersion: 2 }),
      "trace",
    );
    expect(second.supplierJobs[0]?.draftOrderGid).not.toBe(
      first.supplierJobs[0]?.draftOrderGid,
    );
    expect(
      second.actions.filter(
        (action) => action.kind === "SUPERSEDE_SUPPLIER_JOB",
      ),
    ).toHaveLength(2);
  });

  it("cannot recommit a partially cancelled plan or reuse its cancelled jobs", async () => {
    const repository = new TestRepository();
    let fail = false;
    const client = new MockShopifyClient({
      repository,
      beforeEffect: async (effect) => {
        if (
          fail &&
          effect.operation === "supersede" &&
          effect.nodeId === "embroidery"
        )
          throw new ShopifyError("TEST_REJECTION");
      },
    });
    const first = await client.commit(plan(), "initial");
    fail = true;
    const cancelled = await client.supersede(
      plan().orderId,
      plan().planId,
      "cancel",
    );
    expect(cancelled.actions.map((action) => action.status)).toEqual([
      "SUCCEEDED",
      "FAILED",
    ]);
    await expect(client.commit(plan(), "retry")).rejects.toThrow(
      "PLAN_SUPERSEDED",
    );
    const nextPlan = plan({ planId: "next-plan" });
    await expect(client.commit(nextPlan, "replace")).rejects.toThrow(
      "PLAN_CANCELLATION_INCOMPLETE",
    );
    fail = false;
    await client.supersede(plan().orderId, plan().planId, "retry-cancel");
    const next = await client.commit(nextPlan, "replace");
    expect(next.supplierJobs.map((job) => job.draftOrderGid)).not.toEqual(
      first.supplierJobs.map((job) => job.draftOrderGid),
    );
  });

  it("cannot execute or cancel the outgoing plan during an incomplete replacement", async () => {
    const repository = new TestRepository();
    let fail = false;
    const client = new MockShopifyClient({
      repository,
      beforeEffect: async (effect) => {
        if (
          fail &&
          effect.operation === "supersede" &&
          effect.nodeId === "embroidery"
        )
          throw new ShopifyError("TEST_REJECTION");
      },
    });
    await client.commit(plan(), "initial");
    const replacement = plan({
      planId: "replacement",
      nodes: plan().nodes.map((node) => ({
        ...node,
        quantity: node.quantity + 1,
      })),
    });
    fail = true;
    const partial = await client.commit(replacement, "replace");
    expect(partial.actions.map((action) => action.status)).toEqual([
      "SUCCEEDED",
      "FAILED",
    ]);
    await expect(client.commit(plan(), "old")).rejects.toThrow(
      "PLAN_SUPERSEDED",
    );
    await expect(
      client.supersede(plan().orderId, plan().planId, "old"),
    ).rejects.toThrow("PLAN_SUPERSEDED");
    fail = false;
    const recovered = await client.reconcile(replacement, "recover");
    expect(
      recovered.actions.every((action) => action.status === "SUCCEEDED"),
    ).toBe(true);
  });

  it("never revives an already superseded job when abandoning a partially rejected replacement", async () => {
    const repository = new TestRepository();
    let fail = false;
    const client = new MockShopifyClient({
      repository,
      beforeEffect: async (effect) => {
        if (
          fail &&
          effect.operation === "supersede" &&
          effect.nodeId === "embroidery"
        )
          throw new ShopifyError("TEST_REJECTION");
      },
    });
    const first = await client.commit(plan(), "initial");
    const replacement = plan({
      planId: "replacement",
      nodes: plan().nodes.map((node) => ({
        ...node,
        quantity: node.quantity + 1,
      })),
    });
    fail = true;
    await client.commit(replacement, "replace");
    await expect(
      client.supersede(plan().orderId, replacement.planId, "cancel"),
    ).rejects.toThrow("PREVIOUS_EXECUTION_PENDING");
    fail = false;
    const next = await client.commit(plan({ planId: "next" }), "next");
    expect(next.supplierJobs[0]!.draftOrderGid).not.toBe(
      first.supplierJobs[0]!.draftOrderGid,
    );
    const state = (await repository.inspect(plan().orderId))!;
    for (const job of next.supplierJobs)
      expect(
        state.mockResources[job.draftOrderGid]?.resource.tags,
      ).not.toContain("MOLECULE_SUPERSEDED");
    expect(next.actions.every((action) => action.status === "SUCCEEDED")).toBe(
      true,
    );
  });

  it.each(["replace", "cancel"])(
    "retains inherited jobs when a replacement product fails before %s",
    async (operation) => {
      const repository = new TestRepository();
      let fail = false;
      const client = new MockShopifyClient({
        repository,
        beforeEffect: async (effect) => {
          if (fail && effect.operation === "product")
            throw new ShopifyError("TEST_REJECTION");
        },
      });
      const first = await client.commit(plan(), "initial");
      const replacement = plan({ planId: "replacement" });
      fail = true;
      expect(
        (await client.commit(replacement, "replace")).actions.at(-1)?.status,
      ).toBe("FAILED");
      fail = false;
      if (operation === "replace") {
        const next = await client.commit(plan({ planId: "next" }), "next");
        expect(next.supplierJobs).toEqual(first.supplierJobs);
        expect(
          Object.keys(
            (await repository.inspect(plan().orderId))!.mockResources,
          ),
        ).toHaveLength(4);
      } else {
        const cancelled = await client.supersede(
          plan().orderId,
          replacement.planId,
          "cancel",
        );
        expect(cancelled.actions).toHaveLength(2);
        const state = (await repository.inspect(plan().orderId))!;
        for (const job of first.supplierJobs)
          expect(state.mockResources[job.draftOrderGid]?.resource.status).toBe(
            "SUPERSEDED",
          );
      }
    },
  );
});

describe("real adapter with deterministic HTTP provider", () => {
  it("recovers an uncertain cancellation without repeating a supplier mutation", async () => {
    const provider = new FakeShopify();
    const repository = new TestRepository();
    const options = { ...provider.options(), repository };
    const client = new RealShopifyClient(options);
    await client.commit(plan(), "initial");
    provider.fail = (operation, domain) =>
      operation === "UpdateDraft" && domain.startsWith("thread")
        ? "lost-response"
        : undefined;
    const first = await client.supersede(
      plan().orderId,
      plan().planId,
      "cancel",
    );
    expect(first.actions.map((action) => action.status)).toEqual([
      "SUCCEEDED",
      "PENDING",
    ]);
    provider.fail = undefined;
    const result = await new RealShopifyClient(options).supersede(
      plan().orderId,
      plan().planId,
      "recover",
    );
    expect(
      result.actions.every((action) => action.status === "SUCCEEDED"),
    ).toBe(true);
    expect(
      provider.calls.filter((call) => call.operation === "UpdateDraft"),
    ).toHaveLength(2);
  });

  it("creates drafts only, stores real Admin links/variant IDs, and never duplicates concurrent commits", async () => {
    const provider = new FakeShopify();
    const repository = new TestRepository();
    const options = { ...provider.options(), repository };
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () =>
        new RealShopifyClient(options).commit(plan(), "trace"),
      ),
    );
    expect(provider.products.size).toBe(1);
    expect(provider.drafts.size).toBe(3);
    expect(
      provider.calls.filter((call) => call.operation === "CreateDraft"),
    ).toHaveLength(3);
    expect(receipts[0]?.compositeProduct?.adminUrl).toBe(
      "https://molecule.myshopify.com/admin/products/1",
    );
    expect(receipts[0]?.compositeProduct?.variantGid).toMatch(/ProductVariant/);
    expect(receipts[0]?.customerOrder?.checkoutUrl).toContain(
      "https://molecule.myshopify.com/",
    );
    expect(
      provider.calls.some((call) => /Complete|Delete|Pay/.test(call.operation)),
    ).toBe(false);
  });

  it("reconciles a lost create response from its persisted tag without issuing another create", async () => {
    const provider = new FakeShopify();
    const repository = new TestRepository();
    const client = new RealShopifyClient({ ...provider.options(), repository });
    provider.fail = (operation, domain) =>
      operation === "CreateDraft" && domain.startsWith("thread")
        ? "lost-response"
        : undefined;
    const first = await client.commit(plan(), "trace");
    expect(first.actions.at(-1)?.status).toBe("PENDING");
    expect(first.customerOrder).toBeUndefined();
    provider.fail = undefined;
    const next = await new RealShopifyClient({
      ...provider.options(),
      repository,
    }).reconcile(plan(), "trace-2");
    expect(next.actions.every((action) => action.status === "SUCCEEDED")).toBe(
      true,
    );
    expect(
      provider.calls.filter(
        (call) =>
          call.operation === "CreateDraft" && call.domain.startsWith("thread"),
      ),
    ).toHaveLength(1);
  });

  it("never interprets an absent search result as permission to replay an uncertain mutation", async () => {
    const provider = new FakeShopify();
    const repository = new TestRepository();
    const client = new RealShopifyClient({ ...provider.options(), repository });
    provider.fail = (operation) =>
      operation === "CreateDraft" ? "lost-response" : undefined;
    await client.commit(plan(), "trace");
    provider.fail = undefined;
    provider.hideRecovery = true;
    const next = await client.reconcile(plan(), "trace");
    expect(
      next.actions.some((action) => action.errorCode === "OUTCOME_UNKNOWN"),
    ).toBe(true);
    expect(
      provider.calls.filter((call) => call.operation === "CreateDraft"),
    ).toHaveLength(2);
    await expect(
      client.commit(plan({ planId: "plan-2" }), "trace"),
    ).rejects.toThrow("PREVIOUS_EXECUTION_PENDING");
  });

  it("recovers a lost product response and sanitizes provider rejection", async () => {
    const provider = new FakeShopify();
    const repository = new TestRepository();
    const client = new RealShopifyClient({ ...provider.options(), repository });
    provider.fail = (operation) =>
      operation === "Composite" ? "lost-response" : undefined;
    const first = await client.commit(plan(), "trace");
    expect(first.actions[0]?.status).toBe("PENDING");
    await expect(
      client.supersede(plan().orderId, plan().planId, "trace"),
    ).rejects.toThrow("PREVIOUS_EXECUTION_PENDING");
    provider.fail = (operation) =>
      operation === "CreateDraft" ? "bad-input" : undefined;
    const next = await client.reconcile(plan(), "trace");
    expect(next.actions[0]?.status).toBe("SUCCEEDED");
    expect(next.actions[1]?.errorCode).toBe("DRAFT_REJECTED");
    expect(
      JSON.stringify(await repository.inspect(plan().orderId)),
    ).not.toContain("private provider");
    expect(
      provider.calls.filter((call) => call.operation === "Composite"),
    ).toHaveLength(1);
  });

  it("recovers after persistence fails following an accepted provider mutation", async () => {
    class FailedSaveRepository extends TestRepository {
      crash = true;
      override withOrder<T>(
        id: string,
        run: (journal: OrderJournal) => Promise<T>,
      ): Promise<T> {
        return super.withOrder(id, (journal) =>
          run({
            ...journal,
            save: async (state, event) => {
              if (
                this.crash &&
                event.eventType === "shopify.action.succeeded"
              ) {
                this.crash = false;
                throw new ShopifyError("PERSISTENCE_FAILED");
              }
              return journal.save(state, event);
            },
          }),
        );
      }
    }
    const provider = new FakeShopify();
    const repository = new FailedSaveRepository();
    await expect(
      new RealShopifyClient({ ...provider.options(), repository }).commit(
        plan(),
        "trace",
      ),
    ).rejects.toThrow("PERSISTENCE_FAILED");
    expect(provider.products.size).toBe(1);
    const result = await new RealShopifyClient({
      ...provider.options(),
      repository,
    }).reconcile(plan(), "trace");
    expect(
      result.actions.every((action) => action.status === "SUCCEEDED"),
    ).toBe(true);
    expect(
      provider.calls.filter((call) => call.operation === "Composite"),
    ).toHaveLength(1);
  });

  it("blocks disabled execution and missing supplier configuration before effects", async () => {
    const provider = new FakeShopify();
    const repository = new TestRepository();
    await expect(
      new RealShopifyClient({
        ...provider.options(),
        repository,
        executionEnabled: false,
      }).commit(plan(), "trace"),
    ).rejects.toThrow("EXECUTION_DISABLED");
    await expect(
      new RealShopifyClient({
        ...provider.options(),
        repository,
        supplierStores: {},
      }).commit(plan(), "trace"),
    ).rejects.toThrow("SUPPLIER_STORE_NOT_CONFIGURED");
    expect(provider.calls).toHaveLength(0);
  });

  it("retains the draft ID but withholds checkout success when Shopify totals exceed the certified amount", async () => {
    const provider = new FakeShopify();
    provider.tax = 25;
    const repository = new TestRepository();
    const client = new RealShopifyClient({ ...provider.options(), repository });
    const result = await client.commit(plan(), "trace");
    expect(result.actions[1]).toMatchObject({
      status: "PENDING",
      errorCode: "DRAFT_TOTAL_REQUIRES_REVIEW",
      providerRef: "gid://shopify/DraftOrder/1",
    });
    expect(result.customerOrder).toBeUndefined();
    await client.reconcile(plan(), "trace");
    expect(
      provider.calls.filter((call) => call.operation === "CreateDraft"),
    ).toHaveLength(2);
  });

  it("updates retained jobs, supersedes an offline supplier, and reuses one product and customer draft", async () => {
    const provider = new FakeShopify();
    const repository = new TestRepository();
    const client = new RealShopifyClient({ ...provider.options(), repository });
    const first = await client.commit(plan(), "trace");
    const next = await client.commit(
      plan({
        planId: "plan-2",
        nodes: plan().nodes.map((node) =>
          node.nodeId === "embroidery"
            ? { ...node, merchantId: "needle-north" }
            : node,
        ),
      }),
      "recovery",
    );
    expect(next.actions.every((action) => action.status === "SUCCEEDED")).toBe(
      true,
    );
    expect(provider.products.size).toBe(1);
    expect(provider.drafts.size).toBe(4);
    expect(next.customerOrder?.draftOrderGid).toBe(
      first.customerOrder?.draftOrderGid,
    );
    expect(
      provider.drafts.get(
        `thread-forge.myshopify.com:${first.supplierJobs[1]!.draftOrderGid}`,
      )?.tags,
    ).toContain("MOLECULE_SUPERSEDED");
    expect(
      (await repository.inspect(plan().orderId))!.plans[digest("plan-1")]
        ?.superseded,
    ).toBe(true);
  });
});
