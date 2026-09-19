import type {
  MerchantAssistant,
  MerchantDocument,
  OrderThread,
} from "./types.js";

/**
 * Bookkeeping seam for the (merchantId -> assistantId), (merchantId, orderId)
 * -> threadId, and B2 merchant_documents mappings described in the playbook:
 * "Store assistant_id in Tiger merchants table" / "store thread_id in
 * Tiger/order_agent_threads" / "Document IDs must be stored in
 * merchant_documents with version and source timestamps". packages/db and
 * sql/ are owned by the Tiger/Reality track; this interface lets the
 * Backboard track build and test the full merchant-twin lifecycle now, with a
 * Postgres-backed implementation wired in later without changing this
 * contract.
 */
export interface MerchantAgentRepository {
  getAssistant(merchantId: string): Promise<MerchantAssistant | undefined>;
  saveAssistant(record: MerchantAssistant): Promise<void>;
  getThread(
    merchantId: string,
    orderId: string,
  ): Promise<OrderThread | undefined>;
  saveThread(record: OrderThread): Promise<void>;
  listDocuments(merchantId: string): Promise<MerchantDocument[]>;
  saveDocument(record: MerchantDocument): Promise<void>;
}

export class InMemoryMerchantAgentRepository implements MerchantAgentRepository {
  private readonly assistantsByMerchant = new Map<string, MerchantAssistant>();
  private readonly threadsByKey = new Map<string, OrderThread>();
  private readonly documentsByMerchant = new Map<string, MerchantDocument[]>();

  private threadKey(merchantId: string, orderId: string): string {
    return `${merchantId}::${orderId}`;
  }

  async getAssistant(
    merchantId: string,
  ): Promise<MerchantAssistant | undefined> {
    return this.assistantsByMerchant.get(merchantId);
  }

  async saveAssistant(record: MerchantAssistant): Promise<void> {
    this.assistantsByMerchant.set(record.merchantId, record);
  }

  async getThread(
    merchantId: string,
    orderId: string,
  ): Promise<OrderThread | undefined> {
    return this.threadsByKey.get(this.threadKey(merchantId, orderId));
  }

  async saveThread(record: OrderThread): Promise<void> {
    this.threadsByKey.set(
      this.threadKey(record.merchantId, record.orderId),
      record,
    );
  }

  async listDocuments(merchantId: string): Promise<MerchantDocument[]> {
    return [...(this.documentsByMerchant.get(merchantId) ?? [])];
  }

  async saveDocument(record: MerchantDocument): Promise<void> {
    const existing = this.documentsByMerchant.get(record.merchantId) ?? [];
    const withoutSameId = existing.filter(
      (doc) => doc.documentId !== record.documentId,
    );
    withoutSameId.push(record);
    this.documentsByMerchant.set(record.merchantId, withoutSameId);
  }
}
