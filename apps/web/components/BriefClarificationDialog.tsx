"use client";

import type { ClarificationQuestion } from "@molecule/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { useBriefDraft } from "./useBriefDraft";

type Draft = ReturnType<typeof useBriefDraft>;

function answered(answers: Record<string, string>, question: string) {
  return Boolean(answers[question]?.trim());
}

export function BriefClarificationDialog({ draft }: { draft: Draft }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const clarification = draft.clarification;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (clarification && !element.open) element.showModal();
    else if (!clarification && element.open) element.close();
  }, [clarification]);
  return (
    <dialog
      ref={dialog}
      className="clarification-dialog"
      aria-labelledby="clarification-title"
      onClose={() => {
        if (draft.clarification) draft.dismissClarification();
      }}
      onCancel={(event) => {
        if (draft.checking) event.preventDefault();
      }}
    >
      {clarification?.status === "NEEDS_INPUT" && (
        <ClarificationForm
          key={clarification.round}
          questions={clarification.questions}
          summary={clarification.summary}
          round={clarification.round}
          checking={draft.checking}
          onCancel={draft.dismissClarification}
          onSubmit={(answers) => void draft.answer(answers)}
        />
      )}
      {clarification?.status === "UNSUPPORTED" && (
        <>
          <p className="eyebrow">BEFORE WE CONTINUE</p>
          <h2 id="clarification-title">Molecule can’t take on this brief</h2>
          <p className="clarification-summary">{clarification.reason}</p>
          <p className="muted small">
            Nothing was sent and no project was created. Edit the brief and try
            again.
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="primary"
              autoFocus
              onClick={draft.dismissClarification}
            >
              Edit brief
            </button>
          </div>
        </>
      )}
      {clarification?.status === "ERROR" && (
        <>
          <p className="eyebrow">BEFORE WE CONTINUE</p>
          <h2 id="clarification-title">The brief could not be checked</h2>
          <p className="clarification-summary">{clarification.message}</p>
          <p className="muted small">
            Nothing was sent. Retry the check, or send the brief as written and
            answer any follow-up questions in the project.
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="text-button"
              onClick={draft.dismissClarification}
            >
              Edit brief
            </button>
            <button
              type="button"
              className="secondary"
              disabled={draft.checking}
              onClick={() => void draft.sendUnchecked()}
            >
              Send as written
            </button>
            <button
              type="button"
              className="primary"
              autoFocus
              disabled={draft.checking}
              onClick={() => void draft.submit()}
            >
              {draft.checking ? "Checking…" : "Retry check"}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

function ClarificationForm({
  questions,
  summary,
  round,
  checking,
  onCancel,
  onSubmit,
}: {
  questions: ClarificationQuestion[];
  summary: string | undefined;
  round: number;
  checking: boolean;
  onCancel: () => void;
  onSubmit: (answers: { question: string; answer: string }[]) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const remaining = questions.filter(
    (question) => !answered(answers, question.questionId),
  ).length;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (checking) return;
    if (remaining > 0) {
      setAttempted(true);
      return;
    }
    onSubmit(
      questions.map((question) => ({
        question: question.question,
        answer: answers[question.questionId]!.trim(),
      })),
    );
  }
  return (
    <form className="clarification-form" onSubmit={submit} noValidate>
      <p className="eyebrow">BEFORE WE CONTINUE</p>
      <h2 id="clarification-title">
        {round > 1
          ? "A couple more details"
          : questions.length === 1
            ? "One quick question about your brief"
            : "A few quick questions about your brief"}
      </h2>
      <p className="clarification-summary">
        {summary ??
          "Molecule needs these details before it creates the project. Pick a suggestion or type your own answer. Your original brief stays as written."}
      </p>
      <ol className="clarification-questions">
        {questions.map((question, index) => (
          <QuestionField
            key={question.questionId}
            index={index}
            question={question}
            value={answers[question.questionId] ?? ""}
            invalid={attempted && !answered(answers, question.questionId)}
            disabled={checking}
            onChange={(value) =>
              setAnswers((state) => ({
                ...state,
                [question.questionId]: value,
              }))
            }
          />
        ))}
      </ol>
      <p className="clarification-status muted small" role="status">
        {checking
          ? "Checking the updated brief…"
          : remaining === 0
            ? "All questions answered."
            : `${remaining} of ${questions.length} still need an answer.`}
      </p>
      <div className="dialog-actions">
        <button
          type="button"
          className="text-button"
          disabled={checking}
          onClick={onCancel}
        >
          Back to brief
        </button>
        <button type="submit" className="primary" disabled={checking}>
          {checking ? "Checking…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

function QuestionField({
  index,
  question,
  value,
  invalid,
  disabled,
  onChange,
}: {
  index: number;
  question: ClarificationQuestion;
  value: string;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const inputId = `clarify-${question.questionId}`;
  const selected = question.options.find((option) => option.value === value);
  const custom = question.allowCustom || question.options.length === 0;
  return (
    <li className="clarification-question">
      <div className="clarification-question-head">
        <span className="clarification-index" aria-hidden="true">
          {index + 1}
        </span>
        <div>
          {custom ? (
            <label htmlFor={inputId}>{question.question}</label>
          ) : (
            <p className="clarification-label">{question.question}</p>
          )}
          {question.reason && (
            <p className="muted small clarification-reason">
              {question.reason}
            </p>
          )}
        </div>
      </div>
      {question.options.length > 0 && (
        <div
          className="clarification-options"
          role="group"
          aria-label={`Suggestions for: ${question.question}`}
        >
          {question.options.map((option) => {
            const active = selected?.value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={`clarification-option ${active ? "selected" : ""}`}
                aria-pressed={active}
                disabled={disabled}
                title={option.hint}
                onClick={() => onChange(active ? "" : option.value)}
              >
                <span>{option.label}</span>
                {option.hint && <small>{option.hint}</small>}
              </button>
            );
          })}
        </div>
      )}
      {custom && (
        <input
          id={inputId}
          type="text"
          value={value}
          disabled={disabled}
          maxLength={2_000}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${inputId}-error` : undefined}
          placeholder={
            question.inputHint ??
            (question.options.length > 0
              ? "Or type your own answer"
              : "Type your answer")
          }
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {invalid && (
        <p id={`${inputId}-error`} className="inline-warning" role="alert">
          Choose a suggestion or type an answer.
        </p>
      )}
    </li>
  );
}
