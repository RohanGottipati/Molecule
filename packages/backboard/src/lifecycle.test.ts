import { describe, expect, it, vi } from "vitest";

import { MockBackboardAdapter } from "./MockBackboardAdapter.js";
import { InMemoryMerchantAgentRepository } from "./repository.js";
import { createMerchantTwinService } from "./merchantTwin.js";
import type { MerchantIdentity } from "./types.js";
import { buildDemoMerchantCorpus } from "./merchantCorpus.js";

const merchant: MerchantIdentity = {
  merchantId: "merchant-1",
  displayName: "Acme Embroidery",
  specialty: "rush embroidery",
  boundaries: ["Never promise a ship date without checking get_capacity."],
};

describe("merchant twin lifecycle", () => {
  it("serializes concurrent lifecycle creation and deduplicates entries within each batch", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);
    const createAssistant = vi.spyOn(adapter, "createMerchantAssistant");
    const createThread = vi.spyOn(adapter, "createOrReuseOrderThread");
    const upload = vi.spyOn(adapter, "uploadMerchantDocument");
    const remember = vi.spyOn(adapter, "recordMerchantMemory");
    await Promise.all([
      twin.ensureAssistant(merchant),
      twin.ensureAssistant(merchant),
    ]);
    expect(createAssistant).toHaveBeenCalledTimes(1);
    await Promise.all([
      twin.ensureOrderThread({
        merchantId: merchant.merchantId,
        orderId: "same",
      }),
      twin.ensureOrderThread({
        merchantId: merchant.merchantId,
        orderId: "same",
      }),
    ]);
    expect(createThread).toHaveBeenCalledTimes(1);
    const document = buildDemoMerchantCorpus()[0]!;
    await Promise.all([
      twin.ensureMerchantCorpus({
        merchantId: merchant.merchantId,
        documents: [document, document],
      }),
      twin.ensureMerchantCorpus({
        merchantId: merchant.merchantId,
        documents: [document],
      }),
      twin.ensureMerchantMemory({
        merchantId: merchant.merchantId,
        notes: ["policy", "policy"],
      }),
      twin.ensureMerchantMemory({
        merchantId: merchant.merchantId,
        notes: ["policy"],
      }),
    ]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("can retry lifecycle initialization after a failed provider call", async () => {
    const adapter = new MockBackboardAdapter();
    vi.spyOn(adapter, "createMerchantAssistant").mockRejectedValueOnce(
      new Error("outage"),
    );
    const twin = createMerchantTwinService(
      adapter,
      new InMemoryMerchantAgentRepository(),
    );
    await expect(twin.ensureAssistant(merchant)).rejects.toThrow("outage");
    expect((await twin.ensureAssistant(merchant)).merchantId).toBe(
      merchant.merchantId,
    );
  });

  it("reuses the same assistant across orders but creates a distinct thread per order", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);

    const assistantFirstCall = await twin.ensureAssistant(merchant);
    const threadOrderA = await twin.ensureOrderThread({
      merchantId: merchant.merchantId,
      orderId: "order-a",
    });

    const assistantSecondCall = await twin.ensureAssistant(merchant);
    const threadOrderB = await twin.ensureOrderThread({
      merchantId: merchant.merchantId,
      orderId: "order-b",
    });

    expect(assistantSecondCall.assistantId).toBe(
      assistantFirstCall.assistantId,
    );
    expect(threadOrderB.threadId).not.toBe(threadOrderA.threadId);
    expect(threadOrderA.merchantId).toBe(merchant.merchantId);
    expect(threadOrderB.merchantId).toBe(merchant.merchantId);
  });

  it("returns the exact same thread when the same order is requested twice", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);

    await twin.ensureAssistant(merchant);
    const first = await twin.ensureOrderThread({
      merchantId: merchant.merchantId,
      orderId: "order-a",
    });
    const second = await twin.ensureOrderThread({
      merchantId: merchant.merchantId,
      orderId: "order-a",
    });

    expect(second.threadId).toBe(first.threadId);
  });

  it("refuses to create a thread before an assistant exists for the merchant", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);

    await expect(
      twin.ensureOrderThread({
        merchantId: "unknown-merchant",
        orderId: "order-a",
      }),
    ).rejects.toThrow(/no backboard assistant/i);
  });
});
