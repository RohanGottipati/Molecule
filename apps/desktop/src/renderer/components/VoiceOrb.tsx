import type { CSSProperties } from "react";
import type { VoiceSnapshot, VoiceState } from "../services/realtime-client.js";

const ringColor: Partial<Record<VoiceState, string>> = {
  requesting_permission: "#dcaa6b",
  connecting: "#dcaa6b",
  reconnecting: "#dcaa6b",
  listening: "#6ee7b7",
  speech_detected: "#6ee7b7",
  transcribing: "#6ee7b7",
  processing: "#dcaa6b",
  speaking: "#6ee7b7",
  error: "#ff8d87",
};

const spinSpeed: Partial<Record<VoiceState, string>> = {
  requesting_permission: "2.6s",
  connecting: "2.6s",
  reconnecting: "2.6s",
  listening: "6s",
  speech_detected: "3.2s",
  transcribing: "3.2s",
  processing: "1.3s",
  speaking: "3s",
};

/** Idle-state look was designed in Paper to match the reference orb: a dark sphere with a soft, rotating crescent of light. */
export function VoiceOrb({ state }: { state: VoiceSnapshot }) {
  const color = state.muted ? "#aaa99f" : (ringColor[state.state] ?? "#f1efe8");
  const dim = `${color}73`;
  const speed = state.muted ? "9s" : (spinSpeed[state.state] ?? "9s");
  const frozen = state.state === "error";
  return (
    <span
      className={`voice-orb${state.state === "processing" ? " voice-orb-pulse" : ""}`}
      aria-hidden="true"
      style={
        {
          "--orb-ring": color,
          "--orb-dim": dim,
          "--orb-speed": speed,
          "--orb-play": frozen ? "paused" : "running",
        } as CSSProperties
      }
    >
      <span className="voice-orb-ring">
        <span className="voice-orb-ring-glow" />
        <span className="voice-orb-ring-core" />
      </span>
    </span>
  );
}
