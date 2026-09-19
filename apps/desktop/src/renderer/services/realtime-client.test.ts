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
  it("does not replay another project's cached tool result when call IDs collide", async () => {
    const { client, channel, execute } = fixture();
    const call = {
      type: "response.function_call_arguments.done",
      call_id: "same",
      name: "get_project_status",
      arguments: "{}",
    };
    await client.start();
    channel.open();
    channel.emit(call);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    client.resetProject();
    await client.start();
    channel.open();
    channel.emit(call);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls[0]).not.toEqual(execute.mock.calls[1]);
    client.stop();
  });
  it("clears project content but preserves same-project stop history and ignores old channel callbacks", async () => {
    const { client, channel, execute } = fixture();
    await client.start();
    channel.open();
    const oldCallback = channel.onmessage!;
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Private project A",
    });
    channel.emit({ type: "response.created", response: { id: "A" } });
    channel.emit({
      type: "response.output_audio_transcript.delta",
      response_id: "A",
      delta: "Project A response",
    });
    client.stop();
    expect(client.getSnapshot()).toMatchObject({
      transcript: "Private project A",
      response: "Project A response",
      state: "idle",
    });
    client.resetProject();
    expect(client.getSnapshot()).toMatchObject({
      transcript: "",
      response: "",
      state: "idle",
    });
    await client.start();
    channel.open();
    for (const event of [
      {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Late project A",
      },
      {
        type: "response.output_audio_transcript.delta",
        response_id: "A",
        delta: "Late A",
      },
      {
        type: "response.function_call_arguments.done",
        call_id: "old",
        name: "cancel_project",
        arguments: "{}",
      },
    ])
      oldCallback({ data: JSON.stringify(event) });
    expect(client.getSnapshot()).toMatchObject({
      transcript: "",
      response: "",
      state: "listening",
    });
    expect(execute).not.toHaveBeenCalled();
    client.stop();
  });
  it("releases captured audio when backend setup stalls and ignores its late result", async () => {
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof projectResult>) => void;
    const refresh = vi.fn(
      () =>
        new Promise<ReturnType<typeof projectResult>>((resolve) => {
          finish = resolve;
        }),
    );
    const createSession = vi.fn(async () => ({ value: "unused" }));
    const { client, track } = fixture({ refresh, createSession });
    const starting = client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(client.getSnapshot().state).toBe("reconnecting");
    client.stop();
    finish(projectResult());
    await starting;
    expect(createSession).not.toHaveBeenCalled();
  });
  it("requests a realtime grant for the project in the refreshed snapshot", async () => {
    const createSession = vi.fn(async () => ({
      value: "ephemeral-test-secret",
    }));
    const snapshot = projectResult();
    const { client } = fixture({
      createSession,
      refresh: async () => snapshot,
    });
    await client.start();
    expect(createSession).toHaveBeenCalledWith(snapshot.project.orderId);
    client.stop();
  });
  it("ignores late permission denial after stopping", async () => {
    let permit!: (value: boolean) => void;
    const createSession = vi.fn(async () => ({ value: "unused" }));
    const { client } = fixture({
      permission: () =>
        new Promise((resolve) => {
          permit = resolve;
        }),
      createSession,
    });
    const starting = client.start();
    client.stop();
    permit(false);
    await starting;
    expect(client.getSnapshot().state).toBe("idle");
    expect(createSession).not.toHaveBeenCalled();
  });
  it("releases a microphone acquired after the conversation was stopped", async () => {
    let provide!: (stream: MediaStream) => void;
    const stop = vi.fn();
    const media = {
      getUserMedia: vi.fn(
        () =>
          new Promise<MediaStream>((resolve) => {
            provide = resolve;
          }),
      ),
    };
    const { client } = fixture({ media });
    const starting = client.start();
    await vi.waitFor(() => expect(media.getUserMedia).toHaveBeenCalled());
    client.stop();
    provide({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().state).toBe("idle");
  });
  it("does not create a session after a stopped context refresh", async () => {
    let finish!: (value: ReturnType<typeof projectResult>) => void;
    const refresh = vi.fn(
      () =>
        new Promise<ReturnType<typeof projectResult>>((resolve) => {
          finish = resolve;
        }),
    );
    const createSession = vi.fn(async () => ({ value: "unused" }));
    const { client, track } = fixture({ refresh, createSession });
    const starting = client.start();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    client.stop();
    finish(projectResult());
    await starting;
    expect(createSession).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });
  it("keeps an interrupted turn silent when audio playback settles late", async () => {
    let played!: (value?: undefined) => void;
    const { client, channel, audio } = fixture();
    audio.play.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          played = resolve;
        }),
    );
    await client.start();
    channel.open();
    channel.emit({ type: "response.created", response: { id: "old" } });
    channel.emit({ type: "output_audio_buffer.started", response_id: "old" });
    client.interrupt();
    played();
    await Promise.resolve();
    expect(client.getSnapshot().state).toBe("interrupted");
    expect(audio.muted).toBe(true);
    client.stop();
  });
  it("does not apply old turn audio completion or text to a new response", async () => {
    const { client, channel } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "response.created", response: { id: "old" } });
    client.interrupt();
    channel.emit({ type: "response.created", response: { id: "new" } });
    channel.emit({
      type: "response.output_audio_transcript.delta",
      response_id: "new",
      delta: "Current",
    });
    channel.emit({
      type: "response.output_audio_transcript.delta",
      response_id: "old",
      delta: "Stale",
    });
    channel.emit({ type: "output_audio_buffer.stopped", response_id: "old" });
    expect(client.getSnapshot()).toMatchObject({
      state: "thinking",
      response: "Current",
    });
    client.stop();
  });
  it("suppresses untagged tools after interruption and completes silent turns", async () => {
    const { client, channel, execute } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "response.created", response: { id: "old" } });
    client.interrupt();
    channel.emit({
      type: "response.function_call_arguments.done",
      call_id: "late",
      name: "cancel_project",
      arguments: "{}",
    });
    expect(execute).not.toHaveBeenCalled();
    channel.emit({ type: "response.created", response: { id: "new" } });
    channel.emit({
      type: "response.done",
      response: { id: "new", status: "completed" },
    });
    expect(client.getSnapshot().state).toBe("listening");
    client.stop();
  });
  it("does not create another response for an interrupted in-flight tool", async () => {
    let finish!: (value: ReturnType<typeof projectResult>) => void;
    const execute = vi.fn(
      () =>
        new Promise<ReturnType<typeof projectResult>>((resolve) => {
          finish = resolve;
        }),
    );
    const { client, channel } = fixture({ tools: new ToolDispatcher(execute) });
    await client.start();
    channel.open();
    channel.emit({ type: "response.created", response: { id: "old" } });
    channel.emit({
      type: "response.function_call_arguments.done",
      response_id: "old",
      call_id: "ongoing",
      name: "cancel_project",
      arguments: "{}",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    client.interrupt();
    finish(projectResult());
    await Promise.resolve();
    expect(
      channel.send.mock.calls.some(
        ([raw]) => JSON.parse(String(raw)).type === "response.create",
      ),
    ).toBe(false);
    client.stop();
  });
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
