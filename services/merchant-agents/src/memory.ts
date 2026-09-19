import type {
  BackboardAdapter,
  MerchantAgentRepository,
} from "@molecule/backboard";
import {
  MerchantMemoryCardEntrySchema,
  type MerchantMemoryCardEntry,
} from "@molecule/contracts";

export interface MerchantMemoryServiceDeps {
  adapter: BackboardAdapter;
  repository: MerchantAgentRepository;
}

export interface MerchantMemoryService {
  /**
   * B5 item 72: the sanitized fact and its timestamp/source thread only —
   * never the assistant's internal ID or any model reasoning — for a
   * merchant-memory card to render directly. Returns an empty list (never a
   * 404) for a merchant that has no assistant yet, since "no memory recorded"
   * is itself a valid, displayable state.
   */
  listMerchantMemory(merchantId: string): Promise<MerchantMemoryCardEntry[]>;
}

export function createMerchantMemoryService(
  deps: MerchantMemoryServiceDeps,
): MerchantMemoryService {
  async function listMerchantMemory(
    merchantId: string,
  ): Promise<MerchantMemoryCardEntry[]> {
    const assistant = await deps.repository.getAssistant(merchantId);
    if (!assistant) {
      return [];
    }
    const entries = await deps.adapter.recallMerchantMemory({
      merchantId,
      assistantId: assistant.assistantId,
    });
    return entries
      .map((entry) =>
        MerchantMemoryCardEntrySchema.parse({
          merchantId: entry.merchantId,
          memoryId: entry.memoryId,
          note: entry.note,
          sourceThreadId: entry.sourceThreadId,
          recordedAt: entry.recordedAt,
        }),
      )
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  return { listMerchantMemory };
}
