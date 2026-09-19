export type OpenAIErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "REFUSAL"
  | "INCOMPLETE"
  | "VALIDATION"
  | "TRANSPORT";

export class MoleculeOpenAIError extends Error {
  constructor(
    readonly code: OpenAIErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MoleculeOpenAIError";
  }
}
