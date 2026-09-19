import { randomUUID } from "node:crypto";

import { MoleculeEventSchema, type MoleculeEvent } from "@molecule/contracts";

export interface PersistedEvent {
  cursor: number;
  event: MoleculeEvent;
}

export type EventListener = (event: PersistedEvent) => void;

export interface EventStore {
  append(event: MoleculeEvent): Promise<PersistedEvent>;
  list(orderId: string, afterCursor: number): Promise<PersistedEvent[]>;
  subscribe(orderId: string, listener: EventListener): () => void;
}

export class InMemoryEventStore implements EventStore {
  private cursor = 0;
  private readonly events: PersistedEvent[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();

  async append(event: MoleculeEvent): Promise<PersistedEvent> {
    const persisted = {
      cursor: ++this.cursor,
      event: MoleculeEventSchema.parse(event),
    };
    this.events.push(persisted);
    if (event.orderId) {
      for (const listener of this.listeners.get(event.orderId) ?? [])
        listener(persisted);
    }
    return persisted;
  }

  async list(orderId: string, afterCursor: number): Promise<PersistedEvent[]> {
    return this.events.filter(
      ({ cursor, event }) => event.orderId === orderId && cursor > afterCursor,
    );
  }

  subscribe(orderId: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(orderId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(orderId, listeners);
    return () => listeners.delete(listener);
  }
}

export function makeEvent(input: {
  traceId: string;
  orderId?: string;
  planId?: string;
  merchantId?: string;
  eventType: string;
  source: MoleculeEvent["source"];
  severity?: MoleculeEvent["severity"];
  payload?: Record<string, unknown>;
}): MoleculeEvent {
  return MoleculeEventSchema.parse({
    eventId: randomUUID(),
    traceId: input.traceId,
    orderId: input.orderId,
    planId: input.planId,
    merchantId: input.merchantId,
    eventType: input.eventType,
    ts: new Date().toISOString(),
    severity: input.severity ?? "INFO",
    source: input.source,
    payload: input.payload ?? {},
  });
}
