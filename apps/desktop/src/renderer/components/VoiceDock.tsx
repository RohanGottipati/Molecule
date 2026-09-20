import type { ReactNode } from "react";
import { VoiceBeam } from "voice-glow";
import type {
  RealtimeClient,
  VoiceSnapshot,
  VoiceState,
} from "../services/realtime-client.js";

const labels: Record<VoiceState, string> = {
  idle: "Ready when you are",
  requesting_permission: "Requesting microphone…",
  connecting: "Connecting voice…",
  listening: "Listening…",
  speech_detected: "Hearing you…",
  transcribing: "Finishing transcript…",
  processing: "Thinking…",
  speaking: "Speaking — interrupt anytime",
  reconnecting: "Reconnecting voice…",
  error: "Voice needs attention",
};

export function voiceStatusLabel(state: VoiceSnapshot) {
  if (state.muted && !["idle", "error"].includes(state.state))
    return "Microphone muted";
  return labels[state.state];
}

export function VoiceDock({
  voice,
  state,
  children,
}: {
  voice: RealtimeClient;
  state: VoiceSnapshot;
  children: ReactNode;
}) {
  const active = !["idle", "error"].includes(state.state);
  const processing = ["transcribing", "processing"].includes(state.state);
  const reactive =
    !state.muted &&
    ["listening", "speech_detected", "speaking"].includes(state.state);
  return (
    <VoiceBeam
      className="voice-dock-beam"
      level={() => (reactive ? voice.getLevel() : 0)}
      active={active}
      theme="dark"
      processing={processing}
      idle={active && !processing && !state.muted ? 0.06 : 0}
      threshold={0.018}
      attack={0.07}
      release={0.34}
      breatheDuration={6.5}
      flow={24}
      reach={1.05}
      spread={0.72}
      processingDuration={1.25}
      processingLevel={0.34}
      processingEase={0.32}
      processingTravel={1.1}
      processingCurve={2.4}
      colorVariant="forest"
      staticColors
      strength={0.68}
      glowSize={0.78}
      distortion={0.18}
      bandStrength={0.82}
      borderRadius={26}
    >
      {children}
    </VoiceBeam>
  );
}
