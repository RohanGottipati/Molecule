import { afterEach, expect, it, vi } from "vitest";
import { captureFrame } from "./screen-context.js";
import { mockBridge } from "./test-fixtures.js";

function fixture() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  let onFrame!: () => void;
  const video = {
    muted: false,
    srcObject: null,
    videoWidth: 3840,
    videoHeight: 2160,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    requestVideoFrameCallback: vi.fn((callback: () => void) => {
      onFrame = callback;
      return 1;
    }),
    cancelVideoFrameCallback: vi.fn(),
  };
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob: (callback: (blob: Blob) => void) =>
      callback(new Blob(["frame"], { type: "image/png" })),
  };
  const getDisplayMedia = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
  vi.stubGlobal("document", {
    createElement: (tag: string) => (tag === "video" ? video : canvas),
  });
  return {
    video,
    canvas,
    stop,
    stream,
    drawImage,
    getDisplayMedia,
    frame: () => onFrame(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("captures only one frame without audio, limits resolution and releases the source", async () => {
  const { video, canvas, frame, stop, drawImage, getDisplayMedia } = fixture();
  const capture = captureFrame(mockBridge(), "screen:1");
  await vi.waitFor(() => expect(video.play).toHaveBeenCalled());
  frame();
  const file = await capture;
  expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
  expect(file.type).toBe("image/png");
  expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
  expect(drawImage).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(video.srcObject).toBeNull();
});

it("releases screen tracks if playback never settles", async () => {
  vi.useFakeTimers();
  const { video, stop } = fixture();
  video.play.mockImplementation(() => new Promise(() => undefined));
  const capture = captureFrame(mockBridge(), "screen:1");
  const rejected = expect(capture).rejects.toThrow("Screen capture timed out");
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(stop).toHaveBeenCalledOnce();
  expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
});

it("stops capture immediately when its project or visibility is cancelled", async () => {
  const { video, stop } = fixture();
  const controller = new AbortController();
  const capture = captureFrame(mockBridge(), "screen:1", controller.signal);
  const rejected = expect(capture).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() => expect(video.play).toHaveBeenCalled());
  controller.abort();
  await rejected;
  expect(stop).toHaveBeenCalledOnce();
  expect(video.srcObject).toBeNull();
});

it("releases a source returned after capture was cancelled", async () => {
  const { getDisplayMedia, stream, video, stop } = fixture();
  let finish!: (value: MediaStream) => void;
  getDisplayMedia.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const capture = captureFrame(mockBridge(), "screen:1", controller.signal);
  const rejected = expect(capture).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalled());
  controller.abort();
  finish(stream);
  await rejected;
  expect(stop).toHaveBeenCalledOnce();
  expect(video.play).not.toHaveBeenCalled();
});
