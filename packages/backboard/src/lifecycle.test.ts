import { describe, expect, it } from "vitest";

import { MockBackboardAdapter } from "./MockBackboardAdapter.js";
import { InMemoryMerchantAgentRepository } from "./repository.js";
import { createMerchantTwinService } from "./merchantTwin.js";
import type { MerchantIdentity } from "./types.js";

const merchant: MerchantIdentity = {
  merchantId: "merchant-1",
  displayName: "Acme Embroidery",
  specialty: "rush embroidery",
  boundaries: ["Never promise a ship date without checking get_capacity."],
};

describe("merchant twin lifecycle", () => {
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
