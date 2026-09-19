import {
  OrderSessionSnapshotSchema,
  ProjectListQuerySchema,
  type MoleculeEvent,
  type ProjectListQuery,
} from "@molecule/contracts";
import {
  getPool,
  persistEvent,
  readEvents,
  transaction,
  type DbClient,
} from "@molecule/db";
import { subscribePersisted } from "@molecule/events";
import { ActionReceiptSchema, type ActionReceipt } from "./ActionLedger.js";
import {
  StoredContextSchema,
  type ContextStore,
  type StoredContext,
} from "./LocalStore.js";
import type {
  EventListener,
  EventStore,
  PersistedEvent,
} from "./events/EventStore.js";
import {
  SessionConflictError,
  type SessionRepository,
} from "./repositories.js";
import type { OrderSession } from "./session/OrderSession.js";
import {
  projectCursor,
  projectPage,
  projectSummary,
} from "./projectDiscovery.js";
import { prepareContextAttachment } from "./contextAttachment.js";
import { RequestProblem } from "./errors.js";

export class PostgresStore
  implements SessionRepository, EventStore, ContextStore
{
  async listProjects(input: ProjectListQuery) {
    const query = ProjectListQuerySchema.parse(input);
    const cursor = projectCursor(query.cursor);
    const result = await getPool().query<{ session_json: unknown }>(
      `select session_json from order_sessions
       where ($1::text is null or session_json->>'createdAt' < $1
         or (session_json->>'createdAt' = $1 and order_id collate "C" > $2))
       and strpos(lower(order_id || ' ' || coalesce(
         nullif((select string_agg(output->>'name', ', ' order by ordinal)
           from jsonb_array_elements(coalesce(nullif(session_json->'intent','null'::jsonb)->'desiredOutputs','[]'::jsonb))
           with ordinality as outputs(output,ordinal)), ''), 'Untitled production project')), lower($3)) > 0
       order by session_json->>'createdAt' desc, order_id collate "C" asc limit $4`,
      [
        cursor?.createdAt ?? null,
        cursor?.orderId ?? null,
        query.search,
        query.limit + 1,
      ],
    );
    return projectPage(
      result.rows.map(({ session_json }) =>
        projectSummary(OrderSessionSnapshotSchema.parse(session_json)),
      ),
      query.limit,
    );
  }

  async create(session: OrderSession) {
    const parsed = OrderSessionSnapshotSchema.parse(session);
    const result = await getPool().query(
      `insert into order_sessions(order_id,revision,session_json) values($1,$2,$3)
       on conflict do nothing`,
      [parsed.orderId, parsed.revision, parsed],
    );
    if (!result.rowCount)
      throw new SessionConflictError("Order already exists");
  }
  async get(orderId: string) {
    const result = await getPool().query<{ session_json: unknown }>(
      "select session_json from order_sessions where order_id=$1",
      [orderId],
    );
    return result.rows[0]
      ? OrderSessionSnapshotSchema.parse(result.rows[0].session_json)
      : null;
  }
  async save(
    session: OrderSession,
    expectedRevision: number,
    client: DbClient = getPool(),
  ) {
    const parsed = OrderSessionSnapshotSchema.parse(session);
    const result = await client.query(
      `update order_sessions set revision=$2,session_json=$3,updated_at=now()
       where order_id=$1 and revision=$4`,
      [parsed.orderId, parsed.revision, parsed, expectedRevision],
    );
    if (!result.rowCount) throw new SessionConflictError("Workflow superseded");
  }
  async saveWithEvent(
    session: OrderSession,
    revision: number,
    event: MoleculeEvent,
  ) {
    return transaction(async (client) => {
      const persisted = await persistEvent(event, client);
      const next = { ...session, eventCursor: persisted.cursor };
      await this.save(next, revision, client);
      return next;
    });
  }
  append(event: MoleculeEvent) {
    return transaction((client) => persistEvent(event, client));
  }
  async list(orderId: string, afterCursor: number) {
    const result: PersistedEvent[] = [];
    for (;;) {
      const page = await readEvents({ orderId, afterCursor, limit: 1000 });
      result.push(...page);
      if (page.length < 1000) return result;
      afterCursor = page.at(-1)!.cursor;
    }
  }
  subscribe(orderId: string, listener: EventListener) {
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    void subscribePersisted(listener, { orderId, afterCursor: 0 })
      .then((stop) => {
        unsubscribe = stop;
        if (stopped) stop();
      })
      .catch(() => console.error("Event subscription unavailable"));
    return () => {
      stopped = true;
      unsubscribe?.();
    };
  }
  async getReceipt(key: string) {
    const result = await getPool().query<{ receipt: unknown }>(
      "select receipt from orchestrator_actions where action_key=$1",
      [key],
    );
    return result.rows[0]
      ? ActionReceiptSchema.parse(result.rows[0].receipt)
      : undefined;
  }
  async claimReceipt(receipt: ActionReceipt) {
    const result = await getPool().query(
      "insert into orchestrator_actions(action_key,receipt) values($1,$2) on conflict do nothing",
      [receipt.key, ActionReceiptSchema.parse(receipt)],
    );
    return result.rowCount === 1;
  }
  async saveReceipt(receipt: ActionReceipt) {
    await getPool().query(
      `insert into orchestrator_actions(action_key,receipt) values($1,$2)
       on conflict(action_key) do update set receipt=excluded.receipt,updated_at=now()`,
      [receipt.key, ActionReceiptSchema.parse(receipt)],
    );
  }
  async contexts(orderId: string) {
    const result = await getPool().query<{ context_json: unknown }>(
      "select context_json from order_contexts where order_id=$1 order by created_at,context_id",
      [orderId],
    );
    return result.rows.map(({ context_json }) =>
      StoredContextSchema.parse(context_json),
    );
  }
  async attachContext(orderId: string, contextId: string) {
    await transaction(async (client) => {
      const sessions = await client.query<{ session_json: unknown }>(
        "select session_json from order_sessions where order_id=$1 for update",
        [orderId],
      );
      const contexts = await client.query<{ context_json: unknown }>(
        "select context_json from order_contexts where order_id=$1 and context_id=$2 for update",
        [orderId, contextId],
      );
      if (!sessions.rows[0] || !contexts.rows[0])
        throw new RequestProblem(
          404,
          "NOT_FOUND",
          "Project context not found.",
        );
      const session = OrderSessionSnapshotSchema.parse(
        sessions.rows[0].session_json,
      );
      const context = StoredContextSchema.parse(contexts.rows[0].context_json);
      if (context.attached) return;
      const next = prepareContextAttachment(session, context);
      const persisted = await persistEvent(next.event, client);
      await this.save(
        { ...next.session, eventCursor: persisted.cursor },
        session.revision,
        client,
      );
      await client.query(
        "update order_contexts set context_json=$3 where order_id=$1 and context_id=$2",
        [orderId, contextId, { ...context, attached: true }],
      );
    });
  }
  async saveContext(context: StoredContext, bytes?: Buffer) {
    const parsed = StoredContextSchema.parse(context);
    await getPool().query(
      `insert into order_contexts(context_id,order_id,context_json,content) values($1,$2,$3,$4)
       on conflict(context_id) do update set context_json=excluded.context_json,
       content=coalesce(excluded.content,order_contexts.content)`,
      [parsed.asset.assetId, parsed.orderId, parsed, bytes ?? null],
    );
  }
}
