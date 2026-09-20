"use client";

import { useEffect } from "react";
import type { RefObject } from "react";
import type { Workspace } from "../lib/useWorkspace";
import type { useBriefDraft } from "./useBriefDraft";
import { BriefClarificationDialog } from "./BriefClarificationDialog";
import { VoiceOrb } from "./VoiceOrb";
import { productionExample } from "./workspacePresentation";

function AttachIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5m-6 6 6-6 6 6" />
    </svg>
  );
}

/**
 * The landing composer shown before a project exists: a hero question with
 * a text brief field. The voice orb sits beside the send button as a
 * decorative preview — voice isn't wired up in this web release yet.
 */
export function HomeComposer({
  workspace,
  draft,
  textarea,
}: {
  workspace: Workspace;
  draft: ReturnType<typeof useBriefDraft>;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  const submittedProject =
    !workspace.orderId && Boolean(workspace.pendingAction?.orderId);
  const canSend =
    draft.ready &&
    !draft.checking &&
    !submittedProject &&
    workspace.canSubmitMessage &&
    Boolean(draft.text.trim());

  useEffect(() => {
    textarea.current?.focus();
  }, [textarea]);

  return (
    <section className="home-hero" aria-labelledby="home-hero-title">
      <h1 id="home-hero-title">What should we build?</h1>
      <BriefClarificationDialog draft={draft} />
      <div className="home-card">
        <form
          className="home-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend) void draft.submit();
          }}
        >
          <label htmlFor="home-intent" className="sr-only">
            What would you like Molecule to build?
          </label>
          <textarea
            ref={textarea}
            id="home-intent"
            rows={3}
            maxLength={20_000}
            disabled={!draft.ready}
            readOnly={submittedProject}
            value={draft.text}
            onChange={(event) => draft.update(event.target.value)}
            placeholder="What products do you need? Include quantity, deadline, budget and requirements."
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === "Enter" &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                if (canSend) void draft.submit();
              }
            }}
          />
          <div className="home-toolbar">
            <div className="home-toolbar-tools">
              <button
                type="button"
                className="home-icon-button"
                title="Attach context or a logo after creating a project"
                disabled
              >
                <AttachIcon />
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!draft.ready || submittedProject}
                onClick={() => {
                  draft.suggest(productionExample);
                  textarea.current?.focus();
                }}
              >
                {draft.text.trim()
                  ? "Add example to draft"
                  : "Use an example brief"}
              </button>
            </div>
            <div className="home-toolbar-actions">
              <button
                type="button"
                className="home-icon-button home-voice-button"
                aria-label="Voice"
                title="Voice is not enabled in this web release"
                disabled
              >
                <VoiceOrb mood="unavailable" size={42} />
              </button>
              <button
                type="submit"
                className="home-icon-button home-send"
                aria-label={draft.checking ? "Checking brief" : "Send"}
                aria-busy={draft.checking || undefined}
                title={
                  draft.checking
                    ? "Checking your brief for missing details"
                    : "Send (Ctrl/Cmd + Enter)"
                }
                disabled={!canSend}
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </form>
      </div>
      {draft.checking && (
        <p className="composer-feedback" role="status">
          Checking your brief for missing details…
        </p>
      )}
      {draft.storageWarning && (
        <p className="inline-warning" role="status">
          This browser could not save your draft. Keep a copy before leaving or
          reloading.
        </p>
      )}
      {draft.suggestionNotice && (
        <p className="composer-feedback" role="status">
          {draft.suggestionNotice}
        </p>
      )}
    </section>
  );
}
