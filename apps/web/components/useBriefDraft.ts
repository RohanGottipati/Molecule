import { useEffect, useRef, useState } from "react";
import { readDraft, saveDraft, type DraftScope } from "../lib/persistence";
import type { Workspace } from "../lib/useWorkspace";
import { addSuggestion, clearAcknowledgedDraft } from "./workspacePresentation";

export function useBriefDraft(workspace: Workspace) {
  const [draft, setDraft] = useState<{ scope: DraftScope; text: string }>({
    scope: "new:uninitialized",
    text: "",
  });
  const current = useRef(draft);
  const activeScope = useRef(workspace.draftScope);
  activeScope.current = workspace.draftScope;
  const [storageWarning, setStorageWarning] = useState(false);
  const [suggestionNotice, setSuggestionNotice] = useState("");
  useEffect(() => {
    const scope = workspace.draftScope;
    if (scope === "new:uninitialized") return;
    const next = { scope, text: readDraft(scope) };
    current.current = next;
    setDraft(next);
    setSuggestionNotice("");
    setStorageWarning(false);
  }, [workspace.draftScope]);

  function update(text: string) {
    if (
      current.current.scope !== activeScope.current ||
      activeScope.current === "new:uninitialized"
    )
      return;
    const next = { scope: activeScope.current, text };
    current.current = next;
    setDraft(next);
    setStorageWarning(!saveDraft(next.scope, next.text));
    setSuggestionNotice("");
  }
  function suggest(text: string) {
    if (current.current.scope !== activeScope.current) return;
    const hadDraft = Boolean(current.current.text.trim());
    update(addSuggestion(current.current.text, text));
    setSuggestionNotice(
      hadDraft
        ? "Suggestion added after your draft. Review before sending."
        : "Example added to your draft. Review before sending.",
    );
  }
  async function submit() {
    const submitted = { ...current.current };
    if (submitted.scope !== activeScope.current || !workspace.canSubmitMessage)
      return;
    const accepted = await workspace.send(submitted.text);
    if (!accepted) return;
    if (readDraft(submitted.scope) === submitted.text)
      saveDraft(submitted.scope, "");
    const createdScope =
      submitted.scope.startsWith("new:") &&
      activeScope.current.startsWith("project:")
        ? activeScope.current
        : null;
    if (clearAcknowledgedDraft(current.current, submitted, createdScope))
      update("");
  }
  return {
    text: draft.scope === workspace.draftScope ? draft.text : "",
    ready:
      draft.scope === workspace.draftScope &&
      draft.scope !== "new:uninitialized",
    update,
    suggest,
    submit,
    storageWarning,
    suggestionNotice,
  };
}
