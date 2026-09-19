import { MoleculeEventSchema } from "@molecule/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeEvents } from "./events";

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = [];
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    super();
    MockEventSource.instances.push(this);
  }
  ready() {
    this.dispatchEvent(new Event("ready"));
  }
  fail() {
    this.onerror?.();
  }
  emit(data: string, lastEventId: string) {
    this.dispatchEvent(new MessageEvent("molecule", { data, lastEventId }));
  }
}

const event = MoleculeEventSchema.parse({
  eventId: "aabbccdd-1234-4234-9234-123456789abc",
  traceId: "trace-one",
  orderId: "project-one",
  eventType: "solver.valid",
  ts: "2026-09-19T10:00:00Z",
  severity: "INFO",
  source: "solver",
  payload: {},
});
function setup() {
  const callbacks = {
    onReady: vi.fn(),
    onEvent: vi.fn(),
    onInvalid: vi.fn(),
    onReconnect: vi.fn(),
  };
  return { ...callbacks, stop: subscribeEvents("project-one", callbacks) };
}
function latest() {
  return MockEventSource.instances.at(-1)!;
}
beforeEach(() => {
  vi.useFakeTimers();
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("project event reconnection", () => {
  it("recreates failed streams with the last cursor and suppresses replay and retired sources", () => {
    const callbacks = setup();
    const first = latest();
    first.ready();
    first.emit(JSON.stringify(event), "7");
    first.fail();
    expect(first.close).toHaveBeenCalledOnce();
    expect(callbacks.onReconnect).toHaveBeenCalledOnce();
    first.ready();
    first.emit(JSON.stringify(event), "99");
    first.fail();
    expect(callbacks.onReady).toHaveBeenCalledOnce();
    expect(callbacks.onEvent).toHaveBeenCalledOnce();
    expect(callbacks.onReconnect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(500);
    expect(latest().url).toBe("/api/orders/project-one/events?after=7");
    expect(MockEventSource.instances).toHaveLength(2);
    latest().ready();
    latest().emit(JSON.stringify(event), "7");
    latest().emit(
      JSON.stringify({ ...event, eventType: "order.completed" }),
      "8",
    );
    expect(callbacks.onEvent).toHaveBeenCalledTimes(2);
    expect(callbacks.onReady).toHaveBeenCalledTimes(2);
    callbacks.stop();
    expect(latest().close).toHaveBeenCalledOnce();
  });

  it("backs off terminal HTTP failures with a cap and resets after ready", () => {
    const callbacks = setup();
    for (const delay of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
      const count = MockEventSource.instances.length;
      latest().fail();
      vi.advanceTimersByTime(delay - 1);
      expect(MockEventSource.instances).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(MockEventSource.instances).toHaveLength(count + 1);
    }
    latest().ready();
    const count = MockEventSource.instances.length;
    latest().fail();
    vi.advanceTimersByTime(500);
    expect(MockEventSource.instances).toHaveLength(count + 1);
    callbacks.stop();
  });

  it.each([false, true])(
    "cancels pending work on disposal (failed=%s)",
    (failed) => {
      const callbacks = setup();
      const source = latest();
      if (failed) source.fail();
      callbacks.stop();
      source.ready();
      source.emit(JSON.stringify(event), "1");
      source.fail();
      vi.advanceTimersByTime(60_000);
      expect(source.close).toHaveBeenCalledOnce();
      expect(MockEventSource.instances).toHaveLength(1);
      expect(callbacks.onReady).not.toHaveBeenCalled();
      expect(callbacks.onEvent).not.toHaveBeenCalled();
      expect(callbacks.onReconnect).toHaveBeenCalledTimes(failed ? 1 : 0);
    },
  );

  it.each([
    ["invalid JSON", "{", "10"],
    ["another order", JSON.stringify({ ...event, orderId: "other" }), "10"],
    ["missing cursor", JSON.stringify(event), ""],
    ["unsafe cursor", JSON.stringify(event), "9007199254740992"],
  ])("does not advance replay past %s", (_name, data, cursor) => {
    const callbacks = setup();
    latest().emit(data, cursor);
    expect(callbacks.onInvalid).toHaveBeenCalledOnce();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    latest().fail();
    vi.advanceTimersByTime(500);
    expect(latest().url).toBe("/api/orders/project-one/events?after=0");
    callbacks.stop();
  });
});
