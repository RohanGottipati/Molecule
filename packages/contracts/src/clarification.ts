import type { ClarificationAnswer } from "./index.js";

export const CLARIFICATIONS_HEADING = "Clarifications:";

const answerLine = /^-\s*Q:\s*(.+?)\s+A:\s*(.+)$/;

const oneLine = (value: string) => value.replaceAll(/\s+/g, " ").trim();

/** Split a brief into the customer's own text and any appended clarification answers. */
export function splitClarifiedBrief(text: string): {
  brief: string;
  answers: Pick<ClarificationAnswer, "question" | "answer">[];
} {
  const lines = text.split(/\r?\n/);
  let heading = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim() === CLARIFICATIONS_HEADING) {
      heading = index;
      break;
    }
  }
  if (heading === -1) return { brief: text.trim(), answers: [] };
  const answers: Pick<ClarificationAnswer, "question" | "answer">[] = [];
  for (const line of lines.slice(heading + 1)) {
    const match = answerLine.exec(line.trim());
    if (!match) continue;
    answers.push({ question: match[1]!, answer: match[2]! });
  }
  return { brief: lines.slice(0, heading).join("\n").trim(), answers };
}

/**
 * Append clarification answers to the brief without rewriting what the customer wrote.
 * Answers to a question that was already answered replace the earlier answer.
 */
export function composeClarifiedBrief(
  text: string,
  answers: readonly Pick<ClarificationAnswer, "question" | "answer">[],
): string {
  const existing = splitClarifiedBrief(text);
  const merged = new Map(
    existing.answers.map((item) => [
      oneLine(item.question),
      oneLine(item.answer),
    ]),
  );
  for (const item of answers) {
    const question = oneLine(item.question);
    const answer = oneLine(item.answer);
    if (!question || !answer) continue;
    merged.set(question, answer);
  }
  if (merged.size === 0) return existing.brief;
  return [
    existing.brief,
    "",
    CLARIFICATIONS_HEADING,
    ...[...merged].map(([question, answer]) => `- Q: ${question} A: ${answer}`),
  ].join("\n");
}
