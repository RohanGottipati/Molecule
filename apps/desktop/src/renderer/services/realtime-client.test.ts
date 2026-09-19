import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RealtimeClient,
  type RealtimeDependencies,
} from "./realtime-client.js";
import { ToolDispatcher } from "./tool-dispatcher.js";
import { projectResult } from "./test-fixtures.js";

class Channel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
function fixture(overrides: Partial<RealtimeDependencies> = {}) {
  const channel = new Channel();
  const track = { enabled: true, stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const audio = {
    autoplay: false,
    muted: false,
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    srcObject: null,
  };
  const peer = {
    createDataChannel: () => channel,
    addTrack: vi.fn(),
    createOffer: async () => ({ sdp: "offer", type: "offer" }),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
    close: vi.fn(),
    ontrack: null,
    onconnectionstatechange: null,
    connectionState: "new",
  };
  const execute = vi.fn(async () => projectResult());
  const client = new RealtimeClient({
    permission: async () => true,
    createSession: async () => ({ value: "ephemeral-test-secret" }),
    refresh: async () => projectResult(),
    microphoneDevice: () => "",
    tools: new ToolDispatcher(execute),
    media: { getUserMedia: async () => stream as unknown as MediaStream },
    createPeer: () => peer as unknown as RTCPeerConnection,
    createAudio: () => audio as unknown as HTMLAudioElement,
    createAudioContext: () =>
      ({
        close: async () => undefined,
        createMediaStreamSource: () => ({ connect: () => undefined }),
        createAnalyser: () => ({
          fftSize: 256,
          getFloatTimeDomainData: () => undefined,
        }),
      }) as unknown as AudioContext,
    transport: vi.fn(async () => new Response("answer")),
    ...overrides,
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return { client, channel, audio, track, peer, execute };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Realtime lifecycle without paid calls", () => {
  it("stops playback immediately and sends supported WebRTC interruption events", async () => {
    const { client, channel, audio, track, peer } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "response.created", response: { id: "response-1" } });
    channel.emit({
      type: "output_audio_buffer.started",
      response_id: "response-1",
    });
    await vi.waitFor(() => expect(client.getSnapshot().state).toBe("speaking"));
    client.interrupt();
    expect(audio.muted).toBe(true);
    expect(audio.pause).toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "response.cancel", response_id: "response-1" }),
    );
    expect(channel.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "output_audio_buffer.clear" }),
    );
    client.mute(true);
    expect(track.enabled).toBe(false);
    client.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
    expect(client.getSnapshot().state).toBe("idle");
  });
  it("executes a repeated tool call once, with the same stable backend action ID", async () => {
    const { client, channel, execute } = fixture();
    await client.start();
    channel.open();
    const call = {
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "add_constraint",
      arguments: JSON.stringify({
        constraint: {
          field: "material",
          operator: "not_contains",
          value: "polyester",
          hard: true,
        },
      }),
    };
    channel.emit(call);
    channel.emit(call);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: "add_constraint" }),
      "voice:call_1",
    );
    await vi.waitFor(() =>
      expect(
        channel.send.mock.calls.filter(
          ([raw]) =>
            JSON.parse(String(raw)).item?.type === "function_call_output",
        ),
      ).toHaveLength(1),
    );
    client.stop();
  });
  it("does not execute tool calls from a response interrupted before dispatch", async () => {
    const { client, channel, execute } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "response.created", response: { id: "old" } });
    channel.emit({ type: "input_audio_buffer.speech_started" });
    channel.emit({
      type: "response.function_call_arguments.done",
      response_id: "old",
      call_id: "late",
      name: "cancel_project",
      arguments: "{}",
    });
    expect(execute).not.toHaveBeenCalled();
    client.stop();
  });
  it("bounds reconnects and preserves text fallback when credentials are unavailable", async () => {
    vi.useFakeTimers();
    const createSession = vi.fn(async () => {
      throw new Error("Unavailable");
    });
    const { client } = fixture({ createSession });
    await client.start();
    await vi.runAllTimersAsync();
    expect(createSession).toHaveBeenCalledTimes(4);
    expect(client.getSnapshot().error).toBe(
      "Voice is unavailable. You can keep using text.",
    );
    client.stop();
  });
  it("does not negotiate or request a stream after microphone denial", async () => {
    const createSession = vi.fn(async () => ({ value: "unused" }));
    const { client } = fixture({
      permission: async () => false,
      createSession,
    });
    await client.start();
    expect(createSession).not.toHaveBeenCalled();
    expect(client.getSnapshot().error).toContain("Microphone access is off");
    client.stop();
  });
});
