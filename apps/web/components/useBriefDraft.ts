import {
  composeClarifiedBrief,
  type BriefClarificationResult,
  type ClarificationAnswer,
} from "@molecule/contracts";
import { useEffect, useRef, useState } from "react";
import { clarifyBrief } from "../lib/api";
import { readDraft, saveDraft, type DraftScope } from "../lib/persistence";
import type { Workspace } from "../lib/useWorkspace";
import { addSuggestion, clearAcknowledgedDraft } from "./workspacePresentation";

export type BriefClarification =
  | {
      status: "NEEDS_INPUT";
      questions: Extract<
        BriefClarificationResult,
        { status: "NEEDS_INPUT" }
      >["questions"];
      summary?: string;
      round: number;
    }
  | { status: "UNSUPPORTED"; reason: string }
  | { status: "ERROR"; message: string };

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
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [clarification, setClarification] = useState<BriefClarification | null>(
    null,
  );
  const round = useRef(0);
  useEffect(() => {
    const scope = workspace.draftScope;
    if (scope === "new:uninitialized") return;
    const next = { scope, text: readDraft(scope) };
    current.current = next;
    setDraft(next);
    setSuggestionNotice("");
    setStorageWarning(false);
    setClarification(null);
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
  async function deliver(submitted: { scope: DraftScope; text: string }) {
    const accepted = await workspace.send(submitted.text);
    if (!accepted) return false;
    if (readDraft(submitted.scope) === submitted.text)
      saveDraft(submitted.scope, "");
    const createdScope =
      submitted.scope.startsWith("new:") &&
      activeScope.current.startsWith("project:")
        ? activeScope.current
        : null;
    if (clearAcknowledgedDraft(current.current, submitted, createdScope))
      update("");
    return true;
  }
  /**
   * A new brief is checked for missing or ambiguous requirements before a
   * project is created. Updates to an existing project go straight to the
   * conversation, where the compiler already asks follow-up questions.
   */
  function needsPreflight(text: string) {
    if (workspace.orderId || workspace.order?.intent) return false;
    const pending = workspace.pendingAction;
    return !(pending?.payload?.text === text && pending.kind === "create");
  }
  async function preflight(submitted: { scope: DraftScope; text: string }) {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      let result: BriefClarificationResult;
      try {
        result = await clarifyBrief(submitted.text);
      } catch (cause) {
        if (
          submitted.scope === activeScope.current &&
          current.current.text === submitted.text
        )
          setClarification({
            status: "ERROR",
            message:
              cause instanceof Error
                ? cause.message
                : "The brief could not be checked.",
          });
        return;
      }
      if (
        submitted.scope !== activeScope.current ||
        current.current.text !== submitted.text
      )
        return;
      if (result.status === "CLEAR") {
        setClarification(null);
        await deliver(submitted);
        return;
      }
      if (result.status === "UNSUPPORTED") {
        setClarification({ status: "UNSUPPORTED", reason: result.reason });
        return;
      }
      round.current += 1;
      setClarification({
        status: "NEEDS_INPUT",
        questions: result.questions,
        ...(result.summary ? { summary: result.summary } : {}),
        round: round.current,
      });
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }
  async function submit() {
    const submitted = { ...current.current };
    if (
      submitted.scope !== activeScope.current ||
      !workspace.canSubmitMessage ||
      checkingRef.current
    )
      return;
    if (needsPreflight(submitted.text)) await preflight(submitted);
    else await deliver(submitted);
  }
  async function answer(
    answers: readonly Pick<ClarificationAnswer, "question" | "answer">[],
  ) {
    if (current.current.scope !== activeScope.current || checkingRef.current)
      return;
    const composed = composeClarifiedBrief(current.current.text, answers);
    update(composed);
    setClarification(null);
    await preflight({ scope: activeScope.current, text: composed });
  }
  async function sendUnchecked() {
    const submitted = { ...current.current };
    if (
      submitted.scope !== activeScope.current ||
      !workspace.canSubmitMessage ||
      checkingRef.current
    )
      return;
    setClarification(null);
    await deliver(submitted);
  }
  function dismissClarification() {
    setClarification(null);
  }
  return {
    text: draft.scope === workspace.draftScope ? draft.text : "",
    ready:
      draft.scope === workspace.draftScope &&
      draft.scope !== "new:uninitialized",
    update,
    suggest,
    submit,
    checking,
    clarification,
    answer,
    sendUnchecked,
    dismissClarification,
    storageWarning,
    suggestionNotice,
  };
}
