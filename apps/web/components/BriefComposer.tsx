import { useRef, type RefObject } from "react";
import type { Workspace } from "../lib/useWorkspace";
import { VoiceControl } from "./VoiceControl";
import type { useBriefDraft } from "./useBriefDraft";
import { productionExample } from "./workspacePresentation";

export function BriefComposer({
  workspace,
  draft,
  textarea,
}: {
  workspace: Workspace;
  draft: ReturnType<typeof useBriefDraft>;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const closed =
    workspace.order &&
    !workspace.capabilities.canSubmitMessage &&
    ["COMPLETED", "CANCELLED"].includes(workspace.order.state);
  const submittedProject =
    !workspace.orderId && Boolean(workspace.pendingAction?.orderId);
  const canSend =
    draft.ready &&
    !draft.checking &&
    !submittedProject &&
    workspace.canSubmitMessage &&
    Boolean(draft.text.trim());
  return (
    <form
      className="brief-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) void draft.submit();
      }}
    >
      <div className="composer-label">
        <label htmlFor="production-request">
          {workspace.order?.intent ? "Update your brief" : "Production brief"}
        </label>
        <span className="muted small">Ctrl / ⌘ + Enter to send</span>
      </div>
      <textarea
        ref={textarea}
        id="production-request"
        value={draft.text}
        onChange={(event) => draft.update(event.target.value)}
        maxLength={20_000}
        rows={4}
        disabled={!draft.ready}
        readOnly={Boolean(closed || submittedProject)}
        aria-describedby="composer-help"
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
      <p id="composer-help" className="composer-help">
        {submittedProject
          ? "Resume the submitted project to check its result or revise the brief."
          : closed
            ? "This brief is closed. Saved requests and records remain available."
            : workspace.orderId && !workspace.canSubmitMessage
              ? (workspace.capabilities.reason ??
                "Keep your draft here while Molecule finishes the current task.")
              : workspace.order?.intent
                ? "Updates replace the current plan and recheck feasibility."
                : "Molecule checks for missing details, then gets a supplier plan to review. Sending does not approve execution."}
      </p>
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
      <div className="composer-actions">
        <div className="composer-tools">
          {!workspace.order?.intent ? (
            <button
              type="button"
              className="text-button"
              disabled={
                !draft.ready ||
                submittedProject ||
                Boolean(workspace.orderId && !workspace.order)
              }
              onClick={() => {
                draft.suggest(productionExample);
                textarea.current?.focus();
              }}
            >
              {draft.text.trim()
                ? "Add example to draft"
                : "Use an example brief"}
            </button>
          ) : (
            !closed && (
              <button
                type="button"
                className="text-button"
                disabled={!draft.ready}
                onClick={() => {
                  draft.suggest("No polyester");
                  textarea.current?.focus();
                }}
              >
                Add “No polyester” to draft
              </button>
            )
          )}
          <input
            ref={fileInput}
            className="sr-only"
            tabIndex={-1}
            type="file"
            accept=".png,.jpg,.jpeg,.pdf,.csv,.txt,.json"
            aria-label="Choose context or logo file"
            disabled={!workspace.order || !workspace.canSubmitMessage}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void workspace.upload(file);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="text-button"
            disabled={!workspace.order || !workspace.canSubmitMessage}
            onClick={() => fileInput.current?.click()}
          >
            {workspace.operation === "upload"
              ? "Attaching context…"
              : "Attach context / logo"}
          </button>
        </div>
        <button className="primary" type="submit" disabled={!canSend}>
          {draft.checking
            ? "Checking brief…"
            : workspace.operation === "brief"
              ? "Sending…"
              : workspace.order?.intent
                ? "Send update"
                : "Create production project"}
        </button>
      </div>
      <details className="composer-options">
        <summary>Files, voice and saved drafts</summary>
        <p>
          Attach PNG, JPEG, PDF, CSV, text or JSON up to 10 MB after creating a
          project. A further message includes attached context in the
          requirements.
        </p>
        <p>
          Unsent drafts are saved in this browser for each project. A new
          project starts a separate draft.
        </p>
        <VoiceControl />
        {workspace.demoMode &&
          !workspace.configLoading &&
          !workspace.configError && (
            <p>
              Example: onboarding kits. The solver still checks feasibility
              against the configured suppliers.
            </p>
          )}
      </details>
    </form>
  );
}
