import { describe, expect, it } from "vitest";

import { buildDemoMerchantCorpus } from "./merchantCorpus.js";
import { MockBackboardAdapter } from "./MockBackboardAdapter.js";
import { InMemoryMerchantAgentRepository } from "./repository.js";
import { createMerchantTwinService } from "./merchantTwin.js";
import { reconcileWithLiveValue } from "./retrieval.js";
import type { MerchantIdentity } from "./types.js";

const merchant: MerchantIdentity = {
  merchantId: "merchant-1",
  displayName: "Acme Embroidery",
  specialty: "rush embroidery",
  boundaries: ["Never promise a ship date without checking get_capacity."],
};

/**
 * B2 definition of done: document IDs persist with version/source
 * timestamps, a policy question answerable only from uploaded docs comes
 * back through retrieval, and a stale RAG statement loses to a live tool
 * value when they conflict.
 */
describe("merchant RAG corpus", () => {
  it("uploads the demo corpus once and persists version/sourceTimestamp per document", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);
    await twin.ensureAssistant(merchant);

    const documents = buildDemoMerchantCorpus("2026-09-01T00:00:00.000Z");
    const first = await twin.ensureMerchantCorpus({
      merchantId: merchant.merchantId,
      documents,
    });
    const second = await twin.ensureMerchantCorpus({
      merchantId: merchant.merchantId,
      documents,
    });

    expect(first).toHaveLength(documents.length);
    expect(second.map((doc) => doc.documentId)).toEqual(
      first.map((doc) => doc.documentId),
    );

    const stored = await repository.listDocuments(merchant.merchantId);
    expect(stored).toHaveLength(documents.length);
    const shippingDoc = stored.find((doc) => doc.category === "shipping_rules");
    expect(shippingDoc?.version).toBe(1);
    expect(shippingDoc?.sourceTimestamp).toBe("2026-09-01T00:00:00.000Z");

    const staleDoc = stored.find((doc) => doc.stale);
    expect(staleDoc?.category).toBe("equipment_constraints");
    expect(staleDoc?.sourceTimestamp).toBe("2025-01-15T00:00:00.000Z");
  });

  it("refuses to build a corpus before the merchant has an assistant", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);

    await expect(
      twin.ensureMerchantCorpus({
        merchantId: "unknown-merchant",
        documents: buildDemoMerchantCorpus(),
      }),
    ).rejects.toThrow(/no backboard assistant/i);
  });

  it("answers a policy question that is only present in uploaded documents", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);
    const assistant = await twin.ensureAssistant(merchant);
    await twin.ensureMerchantCorpus({
      merchantId: merchant.merchantId,
      documents: buildDemoMerchantCorpus(),
    });

    const chunks = await adapter.retrieveMerchantDocuments({
      merchantId: merchant.merchantId,
      assistantId: assistant.assistantId,
      query: "do customer supplied garments need to be pre-washed",
    });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.category).toBe("materials_policy");
    expect(chunks[0]?.snippet).toMatch(/pre-washed/i);
    expect(chunks[0]?.stale).toBe(false);
  });

  it("caps results at the requested retrieval depth", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);
    const assistant = await twin.ensureAssistant(merchant);
    await twin.ensureMerchantCorpus({
      merchantId: merchant.merchantId,
      documents: buildDemoMerchantCorpus(),
    });

    const chunks = await adapter.retrieveMerchantDocuments({
      merchantId: merchant.merchantId,
      assistantId: assistant.assistantId,
      query: "embroidery machine capacity rush units",
      depth: 1,
    });

    expect(chunks).toHaveLength(1);
  });

  it("lets a live tool value win over a matching stale RAG statement", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);
    const assistant = await twin.ensureAssistant(merchant);
    await twin.ensureMerchantCorpus({
      merchantId: merchant.merchantId,
      documents: buildDemoMerchantCorpus(),
    });

    const chunks = await adapter.retrieveMerchantDocuments({
      merchantId: merchant.merchantId,
      assistantId: assistant.assistantId,
      query: "how many embroidery machines are operational rush capacity",
    });

    // The stale, superseded fixture is the strongest keyword match here.
    expect(chunks[0]?.stale).toBe(true);
    expect(chunks[0]?.snippet).toMatch(/machines|100 units\/day/i);

    const liveCapacity = { available: 12 };
    const reconciled = reconcileWithLiveValue({
      ragChunks: chunks,
      liveValue: liveCapacity,
    });

    expect(reconciled.source).toBe("LIVE_TOOL");
    expect(reconciled.value).toEqual(liveCapacity);
    expect(reconciled.staleWarning).toBe(true);
  });

  it("falls back to a RAG snippet only when no live value exists, flagging staleness", () => {
    const reconciled = reconcileWithLiveValue({
      ragChunks: [
        {
          documentId: "doc_1",
          fileName: "equipment-constraints-2025-01.md",
          category: "equipment_constraints",
          version: 1,
          sourceTimestamp: "2025-01-15T00:00:00.000Z",
          stale: true,
          snippet: "Full rush capacity is 100 units/day across the shop.",
          score: 1,
        },
      ],
      liveValue: undefined,
    });

    expect(reconciled.source).toBe("RAG_DOCUMENT");
    expect(reconciled.staleWarning).toBe(true);
  });
});
