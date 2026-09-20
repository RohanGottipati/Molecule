import type { ApiError } from "@molecule/contracts";
import { MoleculeOpenAIError } from "@molecule/openai";
import { ZodError } from "zod";
import {
  SessionConflictError,
  SupersededSubmissionError,
} from "./repositories.js";
import { InvalidTransitionError } from "./session/transitions.js";

export class RequestProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RequestProblem";
  }
}

export function apiFailure(
  error: Error,
  traceId: string,
): {
  status: number;
  body: ApiError;
} {
  let status = 500;
  let code: ApiError["code"] = "INTERNAL";
  let message =
    "The service could not complete this action. Refresh the project to check its outcome.";
  let retryable = false;
  if (error instanceof RequestProblem) {
    ({ status, code, message } = error);
  } else if (error instanceof ZodError || error instanceof URIError) {
    status = 400;
    code = "VALIDATION_ERROR";
    message =
      "Check the request fields and supported file types, then try again.";
  } else if (
    error instanceof SessionConflictError ||
    error instanceof InvalidTransitionError
  ) {
    status = 409;
    code =
      error instanceof InvalidTransitionError
        ? "INVALID_TRANSITION"
        : "CONFLICT";
    message =
      error instanceof SupersededSubmissionError
        ? "This submission was superseded by a newer project change and was not applied. Review the current brief before submitting again."
        : "The project changed or cannot accept this action. Refresh its status before continuing.";
  } else if (error instanceof MoleculeOpenAIError) {
    const failures: Record<
      MoleculeOpenAIError["code"],
      [number, ApiError["code"], string]
    > = {
      AUTH: [
        502,
        "PROVIDER_AUTH",
        "The model provider could not authenticate. Ask the operator to check its configuration.",
      ],
      RATE_LIMIT: [
        429,
        "RATE_LIMITED",
        "The model provider is busy. Wait briefly, refresh the project, then retry.",
      ],
      TIMEOUT: [
        504,
        "PROVIDER_TIMEOUT",
        "The model provider timed out. Refresh the project to check its outcome.",
      ],
      REFUSAL: [
        422,
        "MODEL_REFUSAL",
        "The model could not process this request. Revise the brief and try again.",
      ],
      INCOMPLETE: [
        502,
        "INCOMPLETE_MODEL_OUTPUT",
        "The model response was incomplete. Refresh the project before retrying.",
      ],
      VALIDATION: [
        502,
        "INCOMPLETE_MODEL_OUTPUT",
        "The model returned an incompatible response. Revise the brief or try again.",
      ],
      TRANSPORT: [
        502,
        "INTERNAL",
        "The model provider is unavailable. Refresh the project before retrying.",
      ],
    };
    [status, code, message] = failures[error.code];
    retryable = error.retryable;
  } else if (
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    status = error.statusCode;
    code = "VALIDATION_ERROR";
    message =
      status === 413
        ? "The file is too large. Choose a file up to 10 MB."
        : "The server could not accept this request. Check its format and try again.";
  }
  return { status, body: { code, message, traceId, retryable } };
}
