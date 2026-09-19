import type { DesktopBridge } from "../../shared/bridge.js";

export async function captureFrame(
  bridge: DesktopBridge,
  sourceId: string,
  signal?: AbortSignal,
): Promise<File> {
  signal?.throwIfAborted();
  await bridge.selectScreenSource(sourceId);
  signal?.throwIfAborted();
  const stream = await navigator.mediaDevices
    .getDisplayMedia({
      video: true,
      audio: false,
    })
    .catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "NotAllowedError")
        throw new Error("Screen context requires Screen Recording permission.");
      throw error;
    });
  const video = document.createElement("video");
  let frame: number | undefined;
  try {
    signal?.throwIfAborted();
    video.muted = true;
    video.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal?.reason);
      const timer = setTimeout(
        () => finish(new Error("Screen capture timed out")),
        5000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      frame = video.requestVideoFrameCallback(() => finish());
      void video.play().catch(finish);
    });
    signal?.throwIfAborted();
    if (!video.videoWidth || !video.videoHeight)
      throw new Error("Screen capture unavailable");
    const scale = Math.min(1, 1920 / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Screen capture unavailable");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error("Screen capture unavailable")),
        "image/png",
      ),
    );
    return new File([blob], `screen-${Date.now()}.png`, { type: "image/png" });
  } finally {
    if (frame !== undefined) video.cancelVideoFrameCallback(frame);
    stream.getTracks().forEach((track) => track.stop());
    video.pause();
    video.srcObject = null;
  }
}
