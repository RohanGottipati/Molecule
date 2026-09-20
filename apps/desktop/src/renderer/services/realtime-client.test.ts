import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MicrophoneLevelProcessor,
  RealtimeClient,
  reduceVoiceState,
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

describe("voice state machine and level processing", () => {
  it("allows only coherent state transitions", () => {
    expect(reduceVoiceState("idle", "speech_started")).toBe("idle");
    let state = reduceVoiceState("idle", "start");
    expect(state).toBe("requesting_permission");
    state = reduceVoiceState(state, "permission_granted");
    expect(state).toBe("connecting");
    state = reduceVoiceState(state, "connected");
    expect(state).toBe("listening");
    state = reduceVoiceState(state, "speech_started");
    expect(state).toBe("speech_detected");
    state = reduceVoiceState(state, "speech_stopped");
    expect(state).toBe("transcribing");
    state = reduceVoiceState(state, "transcript_ready");
    expect(state).toBe("processing");
    state = reduceVoiceState(state, "output_started");
    expect(state).toBe("speaking");
    state = reduceVoiceState(state, "output_stopped");
    expect(state).toBe("listening");
    expect(reduceVoiceState(state, "stop")).toBe("idle");
  });
  it("gates steady room noise while preserving soft through loud speech", () => {
    const processor = new MicrophoneLevelProcessor();
    let sample = processor.sample(0.02);
    for (let index = 0; index < 30; index += 1)
      sample = processor.sample(0.021 + (index % 2) * 0.001);
    expect(sample.level).toBeLessThan(0.02);
    for (let index = 0; index < 8; index += 1) sample = processor.sample(0.045);
    const soft = sample.level;
    for (let index = 0; index < 8; index += 1) sample = processor.sample(0.09);
    const normal = sample.level;
    for (let index = 0; index < 8; index += 1) sample = processor.sample(0.5);
    expect(soft).toBeGreaterThan(0.04);
    expect(normal).toBeGreaterThan(soft);
    expect(sample.level).toBeGreaterThan(normal);
    expect(sample.level).toBeLessThanOrEqual(1);
  });
  it("detects a short utterance and decays cleanly to silence", () => {
    const processor = new MicrophoneLevelProcessor();
    processor.sample(0.005);
    expect(processor.sample(0.08).speech).toBe(false);
    expect(processor.sample(0.08).speech).toBe(false);
    expect(processor.sample(0.08).speech).toBe(true);
    let sample = processor.sample(0);
    for (let index = 0; index < 60; index += 1) sample = processor.sample(0);
    expect(sample).toMatchObject({ level: 0, speech: false });
  });
  it("does not treat silence after sustained speech as a new interruption", () => {
    const meter = new MicrophoneLevelProcessor();
    meter.sample(0);
    for (let frame = 0; frame < 600; frame++) meter.sample(0.12);
    expect(meter.sample(0.12).speech).toBe(true);
    expect(meter.sample(0).speech).toBe(false);
    expect(meter.sample(0.12).speech).toBe(false);
    expect(meter.sample(0.12).speech).toBe(false);
    expect(meter.sample(0.12).speech).toBe(true);
  });
});

describe("Realtime lifecycle without paid calls", () => {
  it("clears archived voice turns when selecting another project", async () => {
    const { client, channel } = fixture();
    await client.start();
    channel.open();
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Private project A",
    });
    client.stop();
    await client.start();
    channel.open();
    expect(client.getSnapshot().history).toMatchObject([
      { speaker: "You", text: "Private project A" },
    ]);
    client.resetProject();
    expect(client.getSnapshot()).toMatchObject({
      state: "idle",
      transcript: "",
      response: "",
      history: [],
    });
  });
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
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Check the project status",
    });
    channel.emit(call);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    client.resetProject();
    await client.start();
    channel.open();
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Check the project status",
    });
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
  it("samples the transmitted stream without notifying React and releases every meter resource", async () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    let amplitude = 0.08;
    const analyser = {
      fftSize: 256,
      getFloatTimeDomainData: (samples: Float32Array) =>
        samples.fill(amplitude),
      disconnect: vi.fn(),
    };
    const context = {
      state: "suspended",
      resume: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      createMediaStreamSource: vi.fn((_stream: MediaStream) => source),
      createAnalyser: () => analyser,
    };
    const { client, channel, peer, track } = fixture({
      createAudioContext: () => context as unknown as AudioContext,
    });
    let frame!: FrameRequestCallback;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      }),
    );
    await client.start();
    channel.open();
    const render = vi.fn();
    const level = vi.fn();
    const unsubscribe = client.subscribe(render);
    const unmeter = client.subscribeLevel(level);
    frame(16);
    expect(client.getLevel()).toBeGreaterThan(0);
    amplitude = 0.5;
    frame(32);
    expect(client.getLevel()).toBeGreaterThan(0);
    amplitude = 0;
    for (let index = 0; index < 100; index++) frame(48 + index);
    expect(client.getLevel()).toBe(0);
    expect(render).not.toHaveBeenCalled();
    expect(context.createMediaStreamSource.mock.calls[0]?.[0]).toBe(
      peer.addTrack.mock.calls[0]?.[1],
    );
    expect(context.resume).toHaveBeenCalledOnce();
    amplitude = 0.1;
    frame(64);
    client.mute(true);
    expect(client.getLevel()).toBe(0);
    frame(80);
    expect(client.getLevel()).toBe(0);
    client.stop();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(analyser.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    const count = level.mock.calls.length;
    frame(96);
    expect(level).toHaveBeenCalledTimes(count);
    unsubscribe();
    unmeter();
  });
  it("keeps speech attention and transcripts on the latest input item", async () => {
    const { client, channel } = fixture();
    await client.start();
    channel.open();
    channel.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "first",
    });
    channel.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "first",
    });
    channel.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "second",
    });
    channel.emit({ type: "response.created", response: { id: "late" } });
    channel.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "first",
    });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "first",
      transcript: "Old request",
    });
    expect(client.getSnapshot()).toMatchObject({
      state: "speech_detected",
      transcript: "",
    });
    channel.emit({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "second",
      delta: "Current request",
    });
    channel.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "second",
    });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "second",
      transcript: "Current request",
    });
    channel.emit({ type: "response.created", response: { id: "current" } });
    channel.emit({
      type: "response.output_audio_transcript.delta",
      item_id: "assistant",
      response_id: "current",
      delta: "Understood",
    });
    expect(client.getSnapshot()).toMatchObject({
      state: "processing",
      transcript: "Current request",
      response: "Understood",
    });
    client.stop();
  });
  it("bounds reconnects even when each unstable connection briefly opens", async () => {
    vi.useFakeTimers();
    const { client, channel } = fixture();
    await client.start();
    for (const delay of [500, 1000, 2000]) {
      channel.open();
      channel.onclose?.();
      await vi.advanceTimersByTimeAsync(delay);
    }
    channel.open();
    channel.onclose?.();
    expect(client.getSnapshot().state).toBe("error");
    expect(client.getLevel()).toBe(0);
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

  it("waits for all tool outputs and response.done before one continuation", async () => {
    const finishes: Array<(value: ReturnType<typeof projectResult>) => void> =
      [];
    const execute = vi.fn(
      () =>
        new Promise<ReturnType<typeof projectResult>>((resolve) =>
          finishes.push(resolve),
        ),
    );
    const { client, channel } = fixture({ tools: new ToolDispatcher(execute) });
    await client.start();
    channel.open();
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "one" });
    channel.emit({ type: "input_audio_buffer.speech_stopped", item_id: "one" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "one",
      transcript: "Show status and plan",
    });
    channel.emit({ type: "response.created", response: { id: "tools" } });
    channel.send.mockClear();
    for (const name of ["get_project_status", "get_active_plan"])
      channel.emit({
        type: "response.function_call_arguments.done",
        response_id: "tools",
        call_id: name,
        name,
        arguments: "{}",
      });
    channel.emit({
      type: "response.done",
      response: { id: "tools", status: "completed" },
    });
    expect(client.getSnapshot().state).toBe("processing");
    const responses = () =>
      channel.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .filter((event) => event.type === "response.create");
    finishes[0]!(projectResult());
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1));
    expect(responses()).toHaveLength(0);
    finishes[1]!(projectResult());
    await vi.waitFor(() => expect(responses()).toHaveLength(1));
    client.stop();
  });
  it("cancels a delayed response.created from a previous request", async () => {
    const { client, channel } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "one" });
    channel.emit({ type: "input_audio_buffer.speech_stopped", item_id: "one" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "one",
      transcript: "Old request",
    });
    const request = channel.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((event) => event.type === "response.create");
    client.interrupt();
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "two" });
    channel.emit({
      type: "response.created",
      response: { id: "stale", metadata: request.response.metadata },
    });
    expect(channel.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "response.cancel", response_id: "stale" }),
    );
    expect(client.getSnapshot().state).toBe("speech_detected");
    client.stop();
  });
  it("recovers when transcription never arrives and ignores its late completion", async () => {
    vi.useFakeTimers();
    const { client, channel, execute } = fixture();
    await client.start();
    channel.open();
    channel.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "lost",
    });
    channel.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "lost",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.getSnapshot()).toMatchObject({
      state: "listening",
      errorCode: "transcription",
    });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "lost",
      transcript: "Cancel it",
    });
    channel.emit({ type: "response.created", response: { id: "late" } });
    channel.emit({
      type: "response.function_call_arguments.done",
      response_id: "late",
      call_id: "late",
      name: "cancel_project",
      arguments: "{}",
    });
    expect(execute).not.toHaveBeenCalled();
    client.stop();
  });
  it.each(["interrupt", "mute"])(
    "discards an unfinished utterance on %s",
    async (action) => {
      const { client, channel, execute } = fixture();
      await client.start();
      channel.open();
      channel.emit({
        type: "input_audio_buffer.speech_started",
        item_id: "cancelled",
      });
      channel.emit({
        type: "input_audio_buffer.speech_stopped",
        item_id: "cancelled",
      });
      if (action === "interrupt") client.interrupt();
      else client.mute(true);
      channel.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "cancelled",
        transcript: "Cancel it",
      });
      channel.emit({ type: "response.created", response: { id: "late" } });
      channel.emit({
        type: "response.function_call_arguments.done",
        response_id: "late",
        call_id: "late",
        name: "cancel_project",
        arguments: "{}",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(client.getSnapshot().state).toBe("listening");
      client.stop();
    },
  );
  it("requests exactly one response after a nonempty committed transcript", async () => {
    const { client, channel } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "one" });
    channel.emit({ type: "input_audio_buffer.speech_stopped", item_id: "one" });
    const completed = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "one",
      transcript: "Show the plan",
    };
    channel.emit(completed);
    channel.emit(completed);
    expect(
      channel.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .filter((event) => event.type === "response.create"),
    ).toHaveLength(1);
    client.stop();
  });
  it("recovers when a response never completes", async () => {
    vi.useFakeTimers();
    const { client, channel } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "response.created", response: { id: "stuck" } });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.getSnapshot()).toMatchObject({
      state: "listening",
      errorCode: "response",
    });
    client.stop();
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
    expect(createSession).toHaveBeenCalledWith(
      snapshot.project.orderId,
      expect.any(AbortSignal),
    );
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
    expect(client.getSnapshot().state).toBe("listening");
    expect(audio.muted).toBe(true);
    client.stop();
  });
  it("does not resurrect playback after a failed response", async () => {
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
    channel.emit({ type: "response.created", response: { id: "failed" } });
    channel.emit({
      type: "output_audio_buffer.started",
      response_id: "failed",
    });
    channel.emit({
      type: "response.done",
      response: { id: "failed", status: "failed" },
    });
    played();
    await Promise.resolve();
    expect(client.getSnapshot()).toMatchObject({
      state: "listening",
      errorCode: "response",
    });
    expect(audio.muted).toBe(true);
    client.stop();
  });
  it("does not apply old turn audio completion or text to a new response", async () => {
    const { client, channel } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "response.created", response: { id: "old" } });
    client.interrupt();
    channel.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "new-input",
    });
    channel.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "new-input",
    });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "new-input",
      transcript: "Show status",
    });
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
      state: "processing",
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
    channel.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "turn",
    });
    channel.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "turn",
    });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn",
      transcript: "Cancel it.",
    });
    channel.emit({ type: "response.created", response: { id: "old" } });
    channel.emit({
      type: "response.function_call_arguments.done",
      response_id: "old",
      call_id: "ongoing",
      name: "cancel_project",
      arguments: "{}",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    channel.send.mockClear();
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
  it.each(["Show my project status.", "Yes, approve the plan."])(
    "requires app confirmation when a model calls approval after %j",
    async (transcript) => {
      const { client, channel, execute } = fixture();
      await client.start();
      channel.open();
      channel.emit({
        type: "input_audio_buffer.speech_started",
        item_id: "turn",
      });
      channel.emit({
        type: "input_audio_buffer.speech_stopped",
        item_id: "turn",
      });
      channel.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "turn",
        transcript,
      });
      channel.emit({
        type: "response.created",
        response: { id: "response-approval" },
      });
      channel.emit({
        type: "response.function_call_arguments.done",
        response_id: "response-approval",
        call_id: "call-approval",
        name: "approve_action",
        arguments: JSON.stringify({ planId: "plan-1", intentVersion: 1 }),
      });
      await vi.waitFor(() =>
        expect(
          channel.send.mock.calls.some(
            ([raw]) =>
              JSON.parse(String(raw)).item?.type === "function_call_output",
          ),
        ).toBe(true),
      );
      const output = channel.send.mock.calls
        .map(([raw]) => JSON.parse(String(raw)))
        .find((event) => event.item?.type === "function_call_output");
      expect(JSON.parse(output.item.output)).toEqual({
        error: "Review the plan and use Approve in the app.",
      });
      expect(execute).not.toHaveBeenCalled();
      client.stop();
    },
  );
  it("executes a repeated tool call once, with the same stable backend action ID", async () => {
    const { client, channel, execute } = fixture();
    await client.start();
    channel.open();
    channel.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "turn",
    });
    channel.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "turn",
    });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn",
      transcript: "No polyester.",
    });
    channel.emit({ type: "response.created", response: { id: "response-1" } });
    const call = {
      type: "response.function_call_arguments.done",
      response_id: "response-1",
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
  it("bounds a data-channel connection that never opens", async () => {
    vi.useFakeTimers();
    const createSession = vi.fn(async () => ({
      value: "ephemeral-test-secret",
    }));
    const { client, track, peer } = fixture({ createSession });
    await client.start();
    expect(client.getSnapshot().state).toBe("connecting");
    await vi.runAllTimersAsync();
    expect(createSession).toHaveBeenCalledTimes(4);
    expect(client.getSnapshot()).toMatchObject({
      state: "error",
      errorCode: "network",
    });
    expect(track.stop).toHaveBeenCalledTimes(4);
    expect(peer.close).toHaveBeenCalledTimes(4);
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
  it("exposes permission resolution as an explicit state", async () => {
    let permit!: (value: boolean) => void;
    const { client } = fixture({
      permission: () =>
        new Promise((resolve) => {
          permit = resolve;
        }),
    });
    const starting = client.start();
    const state = client.getSnapshot().state;
    client.stop();
    permit(false);
    await starting;
    expect(state).toBe("requesting_permission");
  });
  it("coalesces rapid starts into one permission request", async () => {
    const permits: Array<(value: boolean) => void> = [];
    const permission = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          permits.push(resolve);
        }),
    );
    const { client } = fixture({ permission });
    const starts = [client.start(), client.start(), client.start()];
    await Promise.resolve();
    permits.forEach((permit) => permit(false));
    await Promise.all(starts);
    client.stop();
    expect(permission).toHaveBeenCalledTimes(1);
  });
  it("maps a busy microphone to an immediate recoverable error", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException(
        "Could not start audio source",
        "NotReadableError",
      );
    });
    const { client } = fixture({ media: { getUserMedia } });
    await client.start();
    const snapshot = client.getSnapshot();
    client.stop();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      state: "error",
      error: expect.stringContaining("in use"),
    });
  });
  it("does not dispatch a tool for an empty final transcript", async () => {
    const { client, channel, execute } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "input_audio_buffer.speech_started" });
    channel.emit({ type: "input_audio_buffer.speech_stopped" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "   ",
    });
    channel.emit({ type: "response.created", response: { id: "empty" } });
    channel.emit({
      type: "response.function_call_arguments.done",
      response_id: "empty",
      call_id: "empty-call",
      name: "cancel_project",
      arguments: "{}",
    });
    await Promise.resolve();
    client.stop();
    expect(execute).not.toHaveBeenCalled();
  });
  it("ignores transcript deltas after a final transcript", async () => {
    const { client, channel } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "input_audio_buffer.speech_started" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Show orders",
    });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Show orders.",
    });
    channel.emit({
      type: "conversation.item.input_audio_transcription.delta",
      delta: " duplicate",
    });
    const transcript = client.getSnapshot().transcript;
    client.stop();
    expect(transcript).toBe("Show orders.");
  });
  it("recovers from a transcription failure without staying busy", async () => {
    const { client, channel } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "input_audio_buffer.speech_started" });
    channel.emit({ type: "input_audio_buffer.speech_stopped" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.failed",
    });
    const snapshot = client.getSnapshot();
    client.stop();
    expect(snapshot).toMatchObject({
      state: "listening",
      error: "Couldn’t transcribe that. Try again.",
    });
  });
  it("keeps meter frames out of React store notifications", async () => {
    let frame: FrameRequestCallback | undefined;
    const request = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const { client, channel } = fixture({
      createAudioContext: () =>
        ({
          close: async () => undefined,
          createMediaStreamSource: () => ({ connect: () => undefined }),
          createAnalyser: () => ({
            fftSize: 256,
            getFloatTimeDomainData: (samples: Float32Array) =>
              samples.fill(0.1),
          }),
        }) as unknown as AudioContext,
    });
    vi.stubGlobal("requestAnimationFrame", request);
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    await client.start();
    channel.open();
    listener.mockClear();
    for (let index = 0; index < 6; index += 1) {
      const callback = frame;
      if (!callback) throw new Error("Meter frame was not scheduled");
      callback(index * 16);
    }
    const notifications = listener.mock.calls.length;
    unsubscribe();
    client.stop();
    expect(notifications).toBe(0);
  });
  it("waits for a committed transcript before dispatching one tool call", async () => {
    const { client, channel, execute } = fixture();
    await client.start();
    channel.open();
    channel.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "item-current",
    });
    channel.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "item-current",
    });
    channel.emit({
      type: "response.created",
      response: { id: "response-current" },
    });
    const call = {
      type: "response.function_call_arguments.done",
      response_id: "response-current",
      call_id: "queued-call",
      name: "cancel_project",
      arguments: "{}",
    };
    channel.emit(call);
    channel.emit(call);
    expect(execute).not.toHaveBeenCalled();
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-current",
      transcript: "Stop.",
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    client.stop();
  });
  it("ignores out-of-order transcript events from an older utterance", async () => {
    const { client, channel } = fixture();
    await client.start();
    channel.open();
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "old" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "old",
      delta: "Old request",
    });
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "new" });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "old",
      transcript: "Old request.",
    });
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "new",
      transcript: "Show orders.",
    });
    const transcript = client.getSnapshot().transcript;
    client.stop();
    expect(transcript).toBe("Show orders.");
  });
  it.each([
    ["NotAllowedError", "permission", "Microphone access"],
    ["NotFoundError", "no_device", "No microphone"],
    ["AbortError", "audio", "start the microphone"],
    ["OverconstrainedError", "no_device", "Selected microphone"],
  ] as const)(
    "maps %s capture failures without reconnecting",
    async (name, errorCode, copy) => {
      const getUserMedia = vi.fn(async () => {
        throw new DOMException("capture failed", name);
      });
      const { client } = fixture({ media: { getUserMedia } });
      await client.start();
      const snapshot = client.getSnapshot();
      client.stop();
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(snapshot).toMatchObject({
        state: "error",
        errorCode,
        error: expect.stringContaining(copy),
      });
    },
  );
  it("stops cleanly when the selected microphone disconnects", async () => {
    const { client, track } = fixture({ microphoneDevice: () => "external" });
    await client.start();
    const ended = (track as typeof track & { onended?: () => void }).onended;
    expect(ended).toBeTypeOf("function");
    ended?.();
    expect(client.getSnapshot()).toMatchObject({
      state: "error",
      errorCode: "device_lost",
    });
    expect(track.stop).toHaveBeenCalled();
    client.stop();
  });
  it("releases every resource across ten consecutive sessions", async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const { client, channel, track, peer } = fixture({
      createAudioContext: () => {
        const close = vi.fn(async () => undefined);
        closes.push(close);
        return {
          state: "running",
          close,
          createMediaStreamSource: () => ({
            connect: () => undefined,
            disconnect: () => undefined,
          }),
          createAnalyser: () => ({
            fftSize: 256,
            smoothingTimeConstant: 0,
            disconnect: () => undefined,
            getFloatTimeDomainData: () => undefined,
          }),
        } as unknown as AudioContext;
      },
    });
    for (let session = 0; session < 10; session += 1) {
      await client.start();
      channel.open();
      expect(client.getSnapshot().state).toBe("listening");
      client.stop();
      expect(client.getSnapshot().state).toBe("idle");
    }
    await Promise.all(closes.map((close) => close.mock.results[0]?.value));
    expect(closes).toHaveLength(10);
    closes.forEach((close) => expect(close).toHaveBeenCalledTimes(1));
    expect(track.stop).toHaveBeenCalledTimes(10);
    expect(peer.close).toHaveBeenCalledTimes(10);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(10);
  });
  it("resumes a suspended AudioContext before metering", async () => {
    const resume = vi.fn(async () => undefined);
    const { client } = fixture({
      createAudioContext: () =>
        ({
          state: "suspended",
          resume,
          close: async () => undefined,
          createMediaStreamSource: () => ({
            connect: () => undefined,
            disconnect: () => undefined,
          }),
          createAnalyser: () => ({
            fftSize: 256,
            smoothingTimeConstant: 0,
            disconnect: () => undefined,
            getFloatTimeDomainData: () => undefined,
          }),
        }) as unknown as AudioContext,
    });
    await client.start();
    expect(resume).toHaveBeenCalledTimes(1);
    client.stop();
  });
  it("fails gracefully when microphone capture is unsupported", async () => {
    const originalNavigator = globalThis.navigator;
    vi.stubGlobal("navigator", {});
    const { client } = fixture({ media: undefined });
    await client.start();
    const snapshot = client.getSnapshot();
    client.stop();
    vi.stubGlobal("navigator", originalNavigator);
    expect(snapshot).toMatchObject({
      state: "error",
      errorCode: "unsupported",
    });
  });
  it("keeps a thirty-second utterance and bounds an unended turn at one minute", async () => {
    vi.useFakeTimers();
    const { client, channel, track } = fixture();
    await client.start();
    channel.open();
    channel.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "long",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.getSnapshot().state).toBe("speech_detected");
    expect(track.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.getSnapshot()).toMatchObject({
      state: "error",
      errorCode: "audio",
      error: expect.stringContaining("one minute"),
    });
    expect(track.stop).toHaveBeenCalledTimes(1);
    client.stop();
  });
});
