import type { MoleculeEvent } from "@molecule/contracts";
import {
  getPool,
  persistEvent,
  readEvents,
  type DbClient,
  type PersistedEvent,
} from "@molecule/db";

export { readEvents, getRecentEvents, type PersistedEvent } from "@molecule/db";

export async function appendEvent(
  event: MoleculeEvent,
  client: DbClient = getPool(),
): Promise<MoleculeEvent> {
  return (await persistEvent(event, client)).event;
}

export async function listEventsForOrder(
  orderId: string,
  client: DbClient = getPool(),
): Promise<MoleculeEvent[]> {
  const events: MoleculeEvent[] = [];
  let cursor = 0;
  for (;;) {
    const page = await readEvents({ orderId, afterCursor: cursor }, client);
    events.push(...page.map((entry) => entry.event));
    const last = page.at(-1);
    if (!last || page.length < 1000) return events;
    cursor = last.cursor;
  }
}

export interface SubscriptionOptions {
  afterCursor?: number;
  orderId?: string;
  pollMs?: number;
  onError?: (error: unknown) => void | Promise<void>;
}

async function reportSubscriptionError(
  error: unknown,
  options: SubscriptionOptions,
  message: string,
): Promise<void> {
  try {
    if (options.onError) await options.onError(error);
    else console.error(message);
  } catch {
    console.error("Persisted event subscription error handler failed");
  }
}

export async function subscribePersisted(
  listener: (entry: PersistedEvent) => void | Promise<void>,
  options: SubscriptionOptions = {},
): Promise<() => void> {
  if (
    (options.afterCursor !== undefined &&
      (!Number.isSafeInteger(options.afterCursor) ||
        options.afterCursor < 0)) ||
    (options.pollMs !== undefined &&
      (!Number.isInteger(options.pollMs) ||
        options.pollMs < 10 ||
        options.pollMs > 60000))
  ) {
    throw new Error("Invalid subscription cursor or poll interval");
  }
  let cursor = options.afterCursor;
  if (cursor === undefined) {
    const result = await getPool().query<{ cursor: string }>(
      "select coalesce(max(cursor),0) as cursor from molecule_events",
    );
    cursor = Number(result.rows[0]?.cursor ?? 0);
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const page = await readEvents({
        afterCursor: cursor,
        orderId: options.orderId,
      });
      for (const entry of page) {
        if (stopped) return;
        await listener(entry);
        cursor = entry.cursor;
      }
    } catch (error) {
      await reportSubscriptionError(
        error,
        options,
        "Persisted event subscription failed; retrying",
      );
    }
    if (!stopped) timer = setTimeout(() => void poll(), options.pollMs ?? 100);
  };
  void poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function subscribe(
  listener: (event: MoleculeEvent) => void,
  options: SubscriptionOptions = {},
): () => void {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  void subscribePersisted((entry) => listener(entry.event), options)
    .then((stop) => {
      unsubscribe = stop;
      if (stopped) stop();
    })
    .catch((error: unknown) =>
      reportSubscriptionError(
        error,
        options,
        "Persisted event subscription could not start",
      ),
    );
  return () => {
    stopped = true;
    unsubscribe?.();
  };
}
