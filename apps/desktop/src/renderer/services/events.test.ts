import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeEvents,
  mapEvent,
  subscribeEvents,
  type EventFrame,
} from "./events.js";
import { backendEvent } from "./test-fixtures.js";

afterEach(() => vi.useRealTimers());
function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}
describe("replayable backend events", () => {
  it("cancels a stalled reader immediately on project switch", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const completion = consumeEvents(
      new ReadableStream({ cancel }),
      vi.fn(),
      controller.signal,
    );
    controller.abort();
    await completion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("cancels the event response if snapshot reconciliation fails", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const controller = new AbortController();
    const completion = subscribeEvents({
      url: "http://localhost/events",
      signal: controller.signal,
      transport: vi.fn(
        async () => new Response(new ReadableStream({ cancel })),
      ),
      refresh: async () => {
        controller.abort();
        throw new Error("snapshot unavailable");
      },
      onStatus: vi.fn(),
      onEvent: vi.fn(),
    });
    await completion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("resets consecutive failures after a successful ready frame", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let connections = 0;
    const transport = vi.fn(async () => {
      connections += 1;
      if (connections === 8) controller.abort();
      return new Response(stream(["event: ready\ndata: {}\n\n"]));
    });
    const completion = subscribeEvents({
      url: "http://localhost/events",
      signal: controller.signal,
      transport,
      refresh: async () => undefined,
      onStatus: vi.fn(),
      onEvent: vi.fn(),
    });
    await vi.runAllTimersAsync();
    await completion;
    expect(connections).toBe(8);
  });
  it("parses fragmented SSE with CRLF, comments, IDs and multiline data", async () => {
    const frames: EventFrame[] = [];
    await consumeEvents(
      stream([
        "id: 4\r\nevent: mole",
        'cule\r\ndata: {"a":\r\ndata: 2}\r',
        "\n\r\n: heartbeat\n\n",
      ]),
      (frame) => frames.push(frame),
    );
    expect(frames[0]).toEqual({ id: 4, event: "molecule", data: '{"a":\n2}' });
    expect(frames[1]?.data).toBe("");
  });
  it("reconnects with Last-Event-ID, refreshes snapshots and suppresses replay duplicates", async () => {
    vi.useFakeTimers();
    const event = backendEvent("supplier.offline", { merchantId: "failed" });
    const controller = new AbortController();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          stream([
            `id: 7\nevent: molecule\ndata: ${JSON.stringify(event)}\n\nevent: ready\ndata: {}\n\n`,
          ]),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          stream([
            `id: 7\nevent: molecule\ndata: ${JSON.stringify(event)}\n\nevent: ready\ndata: {}\n\nid: 8\nevent: molecule\ndata: ${JSON.stringify(backendEvent("recovery.completed"))}\n\n`,
          ]),
        ),
      );
    const received: { cursor: number; replay: boolean }[] = [];
    const refresh = vi.fn(async () => undefined);
    const completion = subscribeEvents({
      url: "http://localhost/events",
      signal: controller.signal,
      transport,
      refresh,
      onStatus: () => undefined,
      onEvent: (_event, cursor, replay) => {
        received.push({ cursor, replay });
        if (cursor === 8) controller.abort();
      },
    });
    await vi.runAllTimersAsync();
    await completion;
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]?.[1]?.headers).toMatchObject({
      "Last-Event-ID": "7",
    });
    expect(received).toEqual([
      { cursor: 7, replay: true },
      { cursor: 8, replay: false },
    ]);
  });
  it("maps critical events while excluding low-level or private model output", () => {
    expect(mapEvent(backendEvent("supplier.offline"))).toMatchObject({
      alert: true,
      severity: "error",
      notification: expect.stringContaining("failure"),
    });
    expect(mapEvent(backendEvent("recovery.completed"))).toMatchObject({
      alert: true,
      severity: "success",
      label: "Recovered",
    });
    expect(
      mapEvent(backendEvent("model.reasoning.delta", { text: "private" })),
    ).toBeNull();
  });
});
