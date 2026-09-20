import { useEffect, useRef } from "react";
import type { VoiceSnapshot } from "../services/realtime-client.js";
import type { StagedContext } from "../state/desktop-store.js";
import { VoiceOrb } from "./VoiceOrb.js";
import { DockIcon } from "./DockIcon.js";

export function HomeScreen({
  audio,
  text,
  onText,
  onSubmit,
  onAttach,
  onTalk,
  staged,
  onRemove,
  sending,
}: {
  audio: VoiceSnapshot;
  text: string;
  onText: (text: string) => void;
  onSubmit: () => void;
  onAttach: () => void;
  onTalk: () => void;
  staged: StagedContext[];
  onRemove: (id: string) => void;
  sending: boolean;
}) {
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    composer.current?.focus();
  }, []);

  return (
    <div className="home-screen">
      <div className="home-hero">
        <span className="eyebrow">YOUR COMPANY, ON DEMAND</span>
        <h1>What should we build?</h1>
      </div>
      <form
        className="home-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {staged.length > 0 && (
          <ul className="home-staged" aria-label="Context ready to send">
            {staged.map(({ id, file }) => (
              <li key={id}>
                <DockIcon name="attach" />
                <span title={file.name}>{file.name}</span>
                <button
                  type="button"
                  disabled={sending}
                  aria-label={`Remove ${file.name}`}
                  title={`Remove ${file.name}`}
                  onClick={() => onRemove(id)}
                >
                  <DockIcon name="close" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <label htmlFor="home-intent" className="sr-only">
          What would you like Molecule to build?
        </label>
        <textarea
          ref={composer}
          id="home-intent"
          rows={2}
          placeholder="Describe what you'd like Molecule to build…"
          value={text}
          onChange={(event) => onText(event.target.value)}
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
        <div className="home-composer-toolbar">
          <button
            type="button"
            className="home-attach"
            onClick={onAttach}
          >
            <DockIcon name="attach" />
            Attach
          </button>
          <div className="home-composer-actions">
            <button
              type="button"
              className="home-voice-button"
              aria-label="Start voice conversation"
              title="Start voice conversation"
              onClick={onTalk}
            >
              <VoiceOrb state={audio} size={42} />
            </button>
            <button
              type="submit"
              className="home-send"
              aria-label="Send"
              title="Send (Enter)"
              disabled={sending || (!text.trim() && !staged.length)}
            >
              <DockIcon name="send" />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
