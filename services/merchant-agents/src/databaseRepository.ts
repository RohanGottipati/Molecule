import type {
  IndexedDocument,
  MerchantAgentRepository,
  MerchantAssistant,
  MerchantDocument,
  MerchantMemoryEntry,
  OrderThread,
} from "@molecule/backboard";
import { getPool, type DbClient } from "@molecule/db";
import { actionDigest, type MerchantProviderMode } from "./database.js";

export class DatabaseMerchantAgentRepository implements MerchantAgentRepository {
  constructor(
    readonly mode: MerchantProviderMode,
    readonly db: DbClient = getPool(),
  ) {}

  async getAssistant(
    merchantId: string,
  ): Promise<MerchantAssistant | undefined> {
    const result = await this.db.query<{ record: MerchantAssistant }>(
      "select record from merchant_twin_assistants where merchant_id=$1 and mode=$2",
      [merchantId, this.mode],
    );
    return result.rows[0]?.record;
  }

  async listAssistantsForMerchants(
    merchantIds: string[],
  ): Promise<Map<string, MerchantAssistant>> {
    if (!merchantIds.length) return new Map();
    const result = await this.db.query<{
      merchant_id: string;
      record: MerchantAssistant;
    }>(
      `select merchant_id,record from merchant_twin_assistants
       where merchant_id=any($1::text[]) and mode=$2`,
      [merchantIds, this.mode],
    );
    return new Map(result.rows.map((row) => [row.merchant_id, row.record]));
  }

  async syncMerchantAssistantIds(merchantIds: string[]): Promise<void> {
    if (!merchantIds.length) return;
    await this.db.query(
      `update merchants m set backboard_assistant_id=a.record->>'assistantId'
       from merchant_twin_assistants a
       where m.merchant_id=a.merchant_id and a.mode=$2
         and m.merchant_id=any($1::text[])
         and m.backboard_assistant_id is distinct from a.record->>'assistantId'`,
      [merchantIds, this.mode],
    );
  }

  async saveAssistant(record: MerchantAssistant): Promise<void> {
    await this.db.query(
      `insert into merchant_twin_assistants (merchant_id, mode, record)
       values ($1,$2,$3) on conflict do nothing`,
      [record.merchantId, this.mode, record],
    );
  }

  async getThread(
    merchantId: string,
    orderId: string,
  ): Promise<OrderThread | undefined> {
    const result = await this.db.query<{ record: OrderThread }>(
      "select record from merchant_twin_threads where merchant_id=$1 and mode=$2 and order_id=$3",
      [merchantId, this.mode, orderId],
    );
    return result.rows[0]?.record;
  }

  async saveThread(record: OrderThread): Promise<void> {
    await this.db.query(
      `insert into merchant_twin_threads (merchant_id, mode, order_id, record)
       values ($1,$2,$3,$4) on conflict do nothing`,
      [record.merchantId, this.mode, record.orderId, record],
    );
  }

  async listDocuments(merchantId: string): Promise<MerchantDocument[]> {
    return (
      (await this.listDocumentsForMerchants([merchantId])).get(merchantId) ?? []
    );
  }

  async listDocumentsForMerchants(
    merchantIds: string[],
  ): Promise<Map<string, MerchantDocument[]>> {
    if (!merchantIds.length) return new Map();
    const result = await this.db.query<{
      merchant_id: string;
      record: MerchantDocument;
    }>(
      `select merchant_id,record from merchant_twin_documents
       where merchant_id=any($1::text[]) and mode=$2
       order by merchant_id,category,version`,
      [merchantIds, this.mode],
    );
    const documents = new Map<string, MerchantDocument[]>();
    for (const row of result.rows) {
      const entries = documents.get(row.merchant_id) ?? [];
      entries.push(row.record);
      documents.set(row.merchant_id, entries);
    }
    return documents;
  }

  async saveDocument(
    record: MerchantDocument,
    content?: string,
  ): Promise<void> {
    await this.db.query(
      `insert into merchant_twin_documents (merchant_id, mode, category, version, record, content)
       values ($1,$2,$3,$4,$5,$6) on conflict (merchant_id,mode,category,version)
       do update set content=coalesce(merchant_twin_documents.content,excluded.content)`,
      [
        record.merchantId,
        this.mode,
        record.category,
        record.version,
        record,
        content,
      ],
    );
  }

  async listIndexedDocuments(merchantId: string): Promise<IndexedDocument[]> {
    const result = await this.db.query<{
      record: MerchantDocument;
      content: string;
    }>(
      `select record,content from merchant_twin_documents
       where merchant_id=$1 and mode=$2 and content is not null`,
      [merchantId, this.mode],
    );
    return result.rows.map(({ record, content }) => ({ ...record, content }));
  }

  async listMemory(merchantId: string): Promise<MerchantMemoryEntry[]> {
    return (
      (await this.listMemoryForMerchants([merchantId])).get(merchantId) ?? []
    );
  }

  async listMemoryForMerchants(
    merchantIds: string[],
  ): Promise<Map<string, MerchantMemoryEntry[]>> {
    if (!merchantIds.length) return new Map();
    const result = await this.db.query<{
      merchant_id: string;
      record: MerchantMemoryEntry;
    }>(
      `select merchant_id,record from merchant_twin_memories
       where merchant_id=any($1::text[]) and mode=$2
       order by merchant_id,record->>'recordedAt'`,
      [merchantIds, this.mode],
    );
    const memories = new Map<string, MerchantMemoryEntry[]>();
    for (const row of result.rows) {
      const entries = memories.get(row.merchant_id) ?? [];
      entries.push(row.record);
      memories.set(row.merchant_id, entries);
    }
    return memories;
  }

  async saveMemory(record: MerchantMemoryEntry): Promise<void> {
    await this.db.query(
      `insert into merchant_twin_memories (merchant_id,mode,note_hash,record)
       values ($1,$2,$3,$4) on conflict do nothing`,
      [record.merchantId, this.mode, actionDigest(record.note), record],
    );
  }
}
