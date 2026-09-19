import type { MoleculeEvent } from "@molecule/contracts";
import { parseEvent } from "./workspace";

export function subscribeEvents(
  orderId: string,
  callbacks: {
    onReady: () => void;
    onEvent: (event: MoleculeEvent) => void;
    onInvalid: () => void;
    onReconnect: () => void;
  },
) {
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failures = 0;
  let invalid = false;
  let cursor = 0;
  const connect = () => {
    if (stopped) return;
    const current = new EventSource(
      `/api/orders/${encodeURIComponent(orderId)}/events?after=${cursor}`,
    );
    source = current;
    const active = () => !stopped && current === source;
    const reconnect = () => {
      if (!active()) return;
      current.close();
      source = undefined;
      clearTimeout(timer);
      callbacks.onReconnect();
      timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** failures));
      failures = Math.min(failures + 1, 5);
    };
    current.addEventListener("ready", () => {
      if (!active()) return;
      if (!invalid) failures = 0;
      callbacks.onReady();
    });
    current.addEventListener("molecule", (frame: MessageEvent<string>) => {
      if (!active()) return;
      const event = parseEvent(frame.data, orderId);
      const next = Number(frame.lastEventId);
      if (
        !event ||
        !/^\d+$/.test(frame.lastEventId) ||
        !Number.isSafeInteger(next)
      ) {
        invalid = true;
        callbacks.onInvalid();
        reconnect();
        return;
      }
      if (next <= cursor) return;
      invalid = false;
      failures = 0;
      cursor = next;
      callbacks.onEvent(event);
    });
    current.onerror = reconnect;
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
}
