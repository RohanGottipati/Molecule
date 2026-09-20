import { useLayoutEffect, useRef, type RefObject } from "react";
import type {
  RealtimeClient,
  VoiceSnapshot,
} from "../services/realtime-client.js";
import type { StagedContext } from "../state/desktop-store.js";
import { VoiceOrb } from "./VoiceOrb.js";
import { VoiceDock, voiceStatusLabel } from "./VoiceDock.js";
import { DockIcon } from "./DockIcon.js";

export const voiceLabel = voiceStatusLabel;

export interface MoleculeInputProps {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  screenRef: RefObject<HTMLButtonElement | null>;
  text: string;
  onText: (text: string) => void;
  onSubmit: () => void;
  onVoice: () => void;
  onMute: () => void;
  onInterrupt: () => void;
  onAttach: () => void;
  onScreen: () => void;
  onRemove: (id: string) => void;
  compact: boolean;
  audio: VoiceSnapshot;
  staged: StagedContext[];
  sending: boolean;
  pending: boolean;
  status?: string;
}

export function MoleculeInput(props: MoleculeInputProps) {
  const { audio, compact } = props;
  const active = !["idle", "error"].includes(audio.state);
  const interruptible = [
    "speech_detected",
    "transcribing",
    "processing",
    "speaking",
  ].includes(audio.state);
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      {props.staged.length > 0 && (
        <ul className="staged-context" aria-label="Context ready to send">
          {props.staged.map(({ id, file }) => (
            <li key={id}>
              <DockIcon name="attach" />
              <span title={file.name}>{file.name}</span>
              <button
                type="button"
                disabled={props.sending}
                aria-label={`Remove ${file.name}`}
                title={`Remove ${file.name}`}
                onClick={() => props.onRemove(id)}
              >
                <DockIcon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="input-row">
        <label htmlFor="intent" className="sr-only">
          Your request or next instruction
        </label>
        <textarea
          ref={props.inputRef}
          id="intent"
          rows={compact ? 1 : 2}
          placeholder={
            compact ? "Ask Molecule…" : "What would you like to make?"
          }
          value={props.text}
          onChange={(event) => props.onText(event.target.value)}
          aria-describedby="intent-hint"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button
          className={`icon-button mic-button ${active ? "active" : ""}`}
          type="button"
          aria-label={
            active
              ? "Stop voice input"
              : audio.state === "error"
                ? "Retry voice input"
                : "Start voice input"
          }
          title={active ? "End voice conversation" : "Start voice conversation"}
          aria-pressed={active}
          onClick={props.onVoice}
        >
          <VoiceOrb state={audio} />
        </button>
        <button
          className="icon-button primary send-button"
          type="submit"
          title={
            props.staged.length && !props.text.trim()
              ? "Add context to project"
              : "Send instruction (Enter)"
          }
          aria-label={
            props.staged.length && !props.text.trim()
              ? "Add context to project"
              : "Send instruction"
          }
          disabled={
            props.sending || (!props.text.trim() && !props.staged.length)
          }
        >
          <DockIcon name="send" />
        </button>
      </div>
      <div className="input-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label="Attach context"
          title="Attach images or documents"
          onClick={props.onAttach}
        >
          <DockIcon name="attach" />
        </button>
        {!compact && (
          <button
            ref={props.screenRef}
            type="button"
            className="icon-button"
            aria-label="Share screen or window"
            title="Share one screen or window frame"
            onClick={props.onScreen}
          >
            <DockIcon name="screen" />
          </button>
        )}
        <span
          id="voice-status"
          className="input-status"
          role="status"
          aria-live="polite"
        >
          {props.pending && (
            <span className="status-pulse" aria-hidden="true" />
          )}
          {active &&
          !(props.pending && ["listening", "processing"].includes(audio.state))
            ? voiceLabel(audio)
            : (props.status ?? voiceLabel(audio))}
        </span>
        {active && (
          <button
            type="button"
            className="icon-button"
            title={audio.muted ? "Unmute microphone" : "Mute microphone"}
            aria-label={audio.muted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={audio.muted}
            onClick={props.onMute}
          >
            <DockIcon name={audio.muted ? "muted" : "mic"} />
          </button>
        )}
        {interruptible && (
          <button
            type="button"
            className="interrupt-button"
            title="Stop the current voice response"
            onClick={props.onInterrupt}
          >
            Interrupt
          </button>
        )}
      </div>
      <span id="intent-hint" className="sr-only">
        Enter to send. Shift plus Enter for a new line. Escape to collapse, then
        hide.
      </span>
    </form>
  );
}

function LiveInput({
  voice,
  ...props
}: MoleculeInputProps & { voice: RealtimeClient }) {
  const surface = useRef<HTMLDivElement>(null);
  // Each committed getter has its own subscription; samples never render React.
  useLayoutEffect(() =>
    voice.subscribeLevel((level) => {
      if (surface.current)
        surface.current.dataset.audible = String(level > 0.015);
    }),
  );
  return (
    <div ref={surface} className="voice-input" data-audible="false">
      <VoiceDock voice={voice} state={props.audio}>
        <MoleculeInput {...props} />
      </VoiceDock>
    </div>
  );
}

export function VoiceInput({
  voice,
  visible,
  ...props
}: MoleculeInputProps & { voice: RealtimeClient; visible: boolean }) {
  const metering =
    visible &&
    ![
      "idle",
      "error",
      "requesting_permission",
      "connecting",
      "reconnecting",
    ].includes(props.audio.state);
  useLayoutEffect(() => {
    if (visible && document.hasFocus()) props.inputRef.current?.focus();
  }, [metering, visible, props.inputRef]);
  return metering ? (
    <LiveInput voice={voice} {...props} />
  ) : (
    <MoleculeInput {...props} />
  );
}
