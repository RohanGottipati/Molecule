import type { DesktopBridge } from "../../shared/bridge.js";

export async function captureFrame(
  bridge: DesktopBridge,
  sourceId: string,
): Promise<File> {
  await bridge.selectScreenSource(sourceId);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  const video = document.createElement("video");
  try {
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Screen capture timed out")),
        5000,
      );
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    });
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
    stream.getTracks().forEach((track) => track.stop());
    video.pause();
    video.srcObject = null;
  }
}
