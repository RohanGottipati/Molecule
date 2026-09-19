import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AssetRefSchema,
  MoleculeEventSchema,
  OrderSessionSnapshotSchema,
  type MoleculeEvent,
} from "@molecule/contracts";
import { z } from "zod";
import {
  ActionReceiptSchema,
  type ActionReceipt,
  type ReceiptStore,
} from "./ActionLedger.js";
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
import { Serial } from "./serial.js";

export const StoredContextSchema = z.object({
  orderId: z.string(),
  asset: AssetRefSchema,
  attached: z.boolean(),
});
export type StoredContext = z.infer<typeof StoredContextSchema>;
const StateSchema = z.object({
  sessions: z.array(OrderSessionSnapshotSchema).default([]),
  events: z
    .array(z.object({ cursor: z.number(), event: MoleculeEventSchema }))
    .default([]),
  receipts: z.array(ActionReceiptSchema).default([]),
  contexts: z.array(StoredContextSchema).default([]),
});

export class LocalStore implements SessionRepository, EventStore, ReceiptStore {
  private state = StateSchema.parse({});
  private readonly serial = new Serial();
  private readonly listeners = new Map<string, Set<EventListener>>();
  constructor(readonly directory?: string) {}
  async load() {
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.state = StateSchema.parse(
        JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")),
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  private change<T>(
    update: (state: z.infer<typeof StateSchema>) => T,
  ): Promise<T> {
    return this.serial.run(async () => {
      const next = structuredClone(this.state);
      const result = update(next);
      if (this.directory) {
        const path = join(this.directory, "state.next");
        await writeFile(path, JSON.stringify(next), {
          mode: 0o600,
          flush: true,
        });
        await rename(path, join(this.directory, "state.json"));
      }
      this.state = next;
      return result;
    });
  }
  async get(orderId: string) {
    return structuredClone(
      this.state.sessions.find((item) => item.orderId === orderId) ?? null,
    );
  }
  async create(session: OrderSession) {
    await this.change((state) => {
      if (state.sessions.some((item) => item.orderId === session.orderId))
        throw new SessionConflictError();
      state.sessions.push(structuredClone(session));
    });
  }
  async save(session: OrderSession, revision: number) {
    await this.change((state) => {
      const index = state.sessions.findIndex(
        (item) => item.orderId === session.orderId,
      );
      if (state.sessions[index]?.revision !== revision)
        throw new SessionConflictError();
      state.sessions[index] = structuredClone(session);
    });
  }
  async append(event: MoleculeEvent): Promise<PersistedEvent> {
    const persisted = await this.change((state) => {
      const item = {
        cursor: (state.events.at(-1)?.cursor ?? 0) + 1,
        event: MoleculeEventSchema.parse(event),
      };
      state.events.push(item);
      return item;
    });
    for (const listener of this.listeners.get(event.orderId ?? "") ?? [])
      listener(persisted);
    return persisted;
  }
  async list(orderId: string, afterCursor: number) {
    return this.state.events.filter(
      (item) => item.event.orderId === orderId && item.cursor > afterCursor,
    );
  }
  subscribe(orderId: string, listener: EventListener) {
    const listeners = this.listeners.get(orderId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(orderId, listeners);
    return () => {
      listeners.delete(listener);
    };
  }
  async getReceipt(key: string) {
    return this.state.receipts.find((item) => item.key === key);
  }
  async saveReceipt(receipt: ActionReceipt) {
    await this.change((state) => {
      state.receipts = [
        ...state.receipts.filter((item) => item.key !== receipt.key),
        receipt,
      ];
    });
  }
  contexts(orderId: string) {
    return this.state.contexts.filter((item) => item.orderId === orderId);
  }
  async saveContext(context: StoredContext) {
    await this.change((state) => {
      state.contexts = [
        ...state.contexts.filter(
          (item) => item.asset.assetId !== context.asset.assetId,
        ),
        context,
      ];
    });
  }
}
