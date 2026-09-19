import type { BackboardAdapter } from "./BackboardAdapter.js";
import type { MerchantCorpusDocumentInput } from "./merchantCorpus.js";
import type { MerchantAgentRepository } from "./repository.js";
import type {
  MerchantAssistant,
  MerchantDocument,
  MerchantIdentity,
  MerchantMemoryEntry,
  OrderThread,
} from "./types.js";

export interface MerchantTwinService {
  /** Creates the merchant's assistant on first call; every later call reuses it. */
  ensureAssistant(identity: MerchantIdentity): Promise<MerchantAssistant>;
  /**
   * Reuses the stored thread for (merchantId, orderId) if one exists;
   * otherwise creates a new thread under the merchant's existing assistant.
   * A second order for the same merchant always gets a different thread.
   */
  ensureOrderThread(input: {
    merchantId: string;
    orderId: string;
  }): Promise<OrderThread>;
  /**
   * Uploads each corpus document once per (merchantId, category, version);
   * a repeated call reuses the previously stored MerchantDocument instead of
   * re-uploading, mirroring ensureAssistant's idempotency.
   */
  ensureMerchantCorpus(input: {
    merchantId: string;
    documents: MerchantCorpusDocumentInput[];
  }): Promise<MerchantDocument[]>;
  /**
   * B5 item 71: seeds one or more merchant-level corrections into persistent
   * memory, skipping any note already recorded verbatim so demo prep can call
   * this repeatedly without duplicating entries.
   */
  ensureMerchantMemory(input: {
    merchantId: string;
    notes: string[];
    sourceThreadId?: string;
  }): Promise<MerchantMemoryEntry[]>;
}

export function createMerchantTwinService(
  adapter: BackboardAdapter,
  repository: MerchantAgentRepository,
): MerchantTwinService {
  const pending = new Map<string, Promise<unknown>>();

  async function serialize<T>(
    merchantId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = pending.get(merchantId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    pending.set(merchantId, current);
    try {
      return await current;
    } finally {
      if (pending.get(merchantId) === current) pending.delete(merchantId);
    }
  }

  async function ensureAssistant(
    identity: MerchantIdentity,
  ): Promise<MerchantAssistant> {
    const existing = await repository.getAssistant(identity.merchantId);
    if (existing) {
      return existing;
    }
    const created = await adapter.createMerchantAssistant(identity);
    await repository.saveAssistant(created);
    return created;
  }

  async function ensureOrderThread(input: {
    merchantId: string;
    orderId: string;
  }): Promise<OrderThread> {
    const existing = await repository.getThread(
      input.merchantId,
      input.orderId,
    );
    if (existing) {
      return existing;
    }
    const assistant = await repository.getAssistant(input.merchantId);
    if (!assistant) {
      throw new Error(
        `No Backboard assistant exists yet for merchant ${input.merchantId}; call ensureAssistant first`,
      );
    }
    const created = await adapter.createOrReuseOrderThread({
      merchantId: input.merchantId,
      assistantId: assistant.assistantId,
      orderId: input.orderId,
    });
    await repository.saveThread(created);
    return created;
  }

  async function ensureMerchantCorpus(input: {
    merchantId: string;
    documents: MerchantCorpusDocumentInput[];
  }): Promise<MerchantDocument[]> {
    const assistant = await repository.getAssistant(input.merchantId);
    if (!assistant) {
      throw new Error(
        `No Backboard assistant exists yet for merchant ${input.merchantId}; call ensureAssistant first`,
      );
    }
    const existing = await repository.listDocuments(input.merchantId);

    const results: MerchantDocument[] = [];
    for (const doc of input.documents) {
      const already = existing.find(
        (candidate) =>
          candidate.category === doc.category &&
          candidate.version === doc.version,
      );
      if (already) {
        results.push(already);
        continue;
      }
      const uploaded = await adapter.uploadMerchantDocument({
        merchantId: input.merchantId,
        assistantId: assistant.assistantId,
        ...doc,
      });
      await repository.saveDocument(uploaded);
      existing.push(uploaded);
      results.push(uploaded);
    }
    return results;
  }

  async function ensureMerchantMemory(input: {
    merchantId: string;
    notes: string[];
    sourceThreadId?: string;
  }): Promise<MerchantMemoryEntry[]> {
    const assistant = await repository.getAssistant(input.merchantId);
    if (!assistant) {
      throw new Error(
        `No Backboard assistant exists yet for merchant ${input.merchantId}; call ensureAssistant first`,
      );
    }
    const existing = await adapter.recallMerchantMemory({
      merchantId: input.merchantId,
      assistantId: assistant.assistantId,
    });
    const existingNotes = new Set(existing.map((entry) => entry.note));

    const results = [...existing];
    for (const note of input.notes) {
      if (existingNotes.has(note)) {
        continue;
      }
      const recorded = await adapter.recordMerchantMemory({
        merchantId: input.merchantId,
        assistantId: assistant.assistantId,
        note,
        sourceThreadId: input.sourceThreadId,
      });
      results.push(recorded);
      existingNotes.add(note);
    }
    return results;
  }

  return {
    ensureAssistant: (identity) =>
      serialize(identity.merchantId, () => ensureAssistant(identity)),
    ensureOrderThread: (input) =>
      serialize(input.merchantId, () => ensureOrderThread(input)),
    ensureMerchantCorpus: (input) =>
      serialize(input.merchantId, () => ensureMerchantCorpus(input)),
    ensureMerchantMemory: (input) =>
      serialize(input.merchantId, () => ensureMerchantMemory(input)),
  };
}
