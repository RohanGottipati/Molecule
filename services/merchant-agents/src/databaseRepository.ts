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
    const result = await this.db.query<{ record: MerchantDocument }>(
      "select record from merchant_twin_documents where merchant_id=$1 and mode=$2 order by category,version",
      [merchantId, this.mode],
    );
    return result.rows.map((row) => row.record);
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
    const result = await this.db.query<{ record: MerchantMemoryEntry }>(
      "select record from merchant_twin_memories where merchant_id=$1 and mode=$2 order by record->>'recordedAt'",
      [merchantId, this.mode],
    );
    return result.rows.map((row) => row.record);
  }

  async saveMemory(record: MerchantMemoryEntry): Promise<void> {
    await this.db.query(
      `insert into merchant_twin_memories (merchant_id,mode,note_hash,record)
       values ($1,$2,$3,$4) on conflict do nothing`,
      [record.merchantId, this.mode, actionDigest(record.note), record],
    );
  }
}
