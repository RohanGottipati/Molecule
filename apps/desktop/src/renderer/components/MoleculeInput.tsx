import { useLayoutEffect, useRef, type RefObject } from "react";
import { VoiceBeam } from "voice-glow";
import type {
  RealtimeClient,
  VoiceSnapshot,
} from "../services/realtime-client.js";
import type { StagedContext } from "../state/desktop-store.js";
import { DockIcon } from "./DockIcon.js";

export function voiceLabel(audio: VoiceSnapshot): string {
  if (audio.muted && !["idle", "error"].includes(audio.state))
    return "Microphone muted";
  switch (audio.state) {
    case "idle":
      return "Type or talk to Molecule";
    case "connecting":
      return "Opening microphone…";
    case "reconnecting":
      return "Reconnecting voice…";
    case "listening":
      return "Listening";
    case "user-speaking":
      return "Listening to you";
    case "thinking":
      return "Working on your request";
    case "speaking":
      return "Molecule is speaking";
    case "interrupted":
      return "Interrupted · listening";
    case "error":
      return "Voice unavailable · text is ready";
  }
}

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
  const interruptible = ["speaking", "thinking"].includes(audio.state);
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
          aria-label={active ? "Stop voice" : "Start voice"}
          title={active ? "End voice conversation" : "Start voice conversation"}
          aria-pressed={active}
          onClick={props.onVoice}
        >
          <DockIcon name={active ? "stop" : "mic"} />
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
        <span className="input-status" role="status" aria-live="polite">
          {props.pending && (
            <span className="status-pulse" aria-hidden="true" />
          )}
          {active &&
          !(props.pending && ["listening", "thinking"].includes(audio.state))
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
  let yourLevel = voice.getLevel();
  // Each committed getter has its own subscription; samples never render React.
  useLayoutEffect(() =>
    voice.subscribeLevel((level) => {
      yourLevel = level;
      if (surface.current)
        surface.current.dataset.audible = String(level > 0.015);
    }),
  );
  return (
    <div ref={surface} className="voice-input" data-audible="false">
      <VoiceBeam level={() => yourLevel}>
        <MoleculeInput {...props} />
      </VoiceBeam>
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
    !["idle", "error", "connecting", "reconnecting"].includes(
      props.audio.state,
    );
  useLayoutEffect(() => {
    if (visible && document.hasFocus()) props.inputRef.current?.focus();
  }, [metering, visible, props.inputRef]);
  return metering ? (
    <LiveInput voice={voice} {...props} />
  ) : (
    <MoleculeInput {...props} />
  );
}
