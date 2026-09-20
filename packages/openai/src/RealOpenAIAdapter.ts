import { createHash } from "node:crypto";

import {
  BriefClarificationRequestSchema,
  ClaimExtractionRequestSchema,
  ClaimExtractionResultSchema,
  CompileIntentRequestSchema,
  type BriefClarificationRequest,
  type BriefClarificationResult,
  type ClaimExtractionRequest,
  type ClaimExtractionResult,
  type CompileIntentRequest,
  type CompileIntentResult,
  type ProductIntentDraft,
} from "@molecule/contracts";
import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputContent } from "openai/resources/responses/responses";
import { ZodError } from "zod";

import {
  clarificationCompileRequest,
  clarificationFromCompile,
  withSuggestedOptions,
  type SuggestedOptions,
} from "./clarifyBrief.js";
import { MoleculeOpenAIError } from "./errors.js";
import { mapExtractionToResult } from "./mapExtraction.js";
import type { OpenAIAdapter, RealtimeClientSecret } from "./OpenAIAdapter.js";
import {
  INTENT_COMPILER_INSTRUCTIONS,
  INTENT_PROMPT_VERSION,
} from "./prompts/intentCompiler.js";
import {
  CLARIFICATION_PROMPT_VERSION,
  CLARIFICATION_SUGGESTER_INSTRUCTIONS,
} from "./prompts/clarificationSuggester.js";
import { IntentExtractionSchema } from "./schema/intentExtraction.js";
import { ClaimExtractionOutputSchema } from "./schema/claimExtraction.js";
import { ClarificationSuggestionSchema } from "./schema/clarificationSuggestion.js";
import {
  DESKTOP_VOICE_INSTRUCTIONS,
  DESKTOP_VOICE_TOOLS,
} from "./prompts/desktopVoice.js";

export interface RealOpenAIAdapterOptions {
  apiKey: string;
  compilerModel?: string;
  realtimeModel?: string;
  transcriptionModel?: string;
  timeoutMs?: number;
  client?: OpenAI;
}

function safeProviderMessage(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  return error.message
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|ek_[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replaceAll(/\s+/g, " ")
    .slice(0, 300);
}

export class RealOpenAIAdapter implements OpenAIAdapter {
  private readonly client: OpenAI;
  private readonly compilerModel: string;
  private readonly realtimeModel: string;

  constructor(private readonly options: RealOpenAIAdapterOptions) {
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        timeout: options.timeoutMs ?? 25_000,
        maxRetries: 1,
      });
    this.compilerModel = options.compilerModel?.trim() || "gpt-5.6-terra";
    this.realtimeModel = options.realtimeModel?.trim() || "gpt-realtime-2.1";
  }

  async compileIntent(
    input: CompileIntentRequest,
  ): Promise<CompileIntentResult> {
    const parsedInput = CompileIntentRequestSchema.parse(input);
    const safetyIdentifier = createHash("sha256")
      .update(parsedInput.orderId)
      .digest("hex");
    const assets = [
      ...new Map(
        [
          ...(parsedInput.previousIntent?.assets ?? []),
          ...parsedInput.assets,
        ].map((asset) => [asset.assetId, asset]),
      ).values(),
    ];
    const context = {
      requestTimestamp: parsedInput.requestedAt,
      locale: parsedInput.locale,
      timeZone: parsedInput.timeZone,
      customerText: parsedInput.text,
      correction: parsedInput.correction ?? null,
      previousIntent: parsedInput.previousIntent ?? null,
      assets,
    };

    try {
      let issues: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const assetContent: ResponseInputContent[] = [];
        for (const asset of assets) {
          if (!asset.url && !asset.providerFileId) continue;
          if (asset.mimeType?.startsWith("image/")) {
            assetContent.push({
              type: "input_image",
              ...(asset.providerFileId
                ? { file_id: asset.providerFileId }
                : { image_url: asset.url }),
              detail: "auto",
            });
          } else {
            assetContent.push({
              type: "input_file",
              ...(asset.providerFileId
                ? { file_id: asset.providerFileId }
                : { file_url: asset.url }),
            });
          }
        }
        try {
          const response = await this.client.responses.parse(
            {
              model: this.compilerModel,
              instructions: INTENT_COMPILER_INSTRUCTIONS,
              input: [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: JSON.stringify({
                        ...context,
                        validationFeedback: attempt === 0 ? null : issues,
                      }),
                    },
                    ...assetContent,
                  ],
                },
              ],
              text: {
                format: zodTextFormat(IntentExtractionSchema, "product_intent"),
              },
              store: false,
              max_output_tokens: 6000,
              safety_identifier: safetyIdentifier,
              metadata: {
                trace_id: parsedInput.traceId,
                prompt_version: INTENT_PROMPT_VERSION,
              },
            },
            {
              timeout: this.options.timeoutMs ?? 25_000,
              headers: {
                "Idempotency-Key": createHash("sha256")
                  .update(
                    `${parsedInput.traceId}:compile:${attempt}:${JSON.stringify(context)}`,
                  )
                  .digest("hex"),
              },
            },
          );

          if (response.status === "incomplete") {
            throw new MoleculeOpenAIError(
              "INCOMPLETE",
              `OpenAI response incomplete: ${response.incomplete_details?.reason ?? "unknown"}`,
              response.incomplete_details?.reason === "max_output_tokens",
            );
          }
          if (response.status !== "completed") {
            throw new MoleculeOpenAIError(
              "TRANSPORT",
              "OpenAI did not complete compilation",
              true,
            );
          }
          if (response.output_parsed === null) {
            const refusal = response.output
              .filter((item) => item.type === "message")
              .flatMap((item) => item.content)
              .find((item) => item.type === "refusal");
            if (refusal) {
              throw new MoleculeOpenAIError(
                "REFUSAL",
                "OpenAI refused the request",
                false,
              );
            }
            issues = ["output_parsed was null"];
            continue;
          }

          const extraction = IntentExtractionSchema.safeParse(
            response.output_parsed,
          );
          if (!extraction.success) {
            issues = extraction.error.issues.map(
              ({ code, path }) => `${path.join(".")}:${code}`,
            );
            continue;
          }

          const result = mapExtractionToResult(
            extraction.data,
            parsedInput.previousIntent,
            assets,
          );
          if (
            extraction.data.outcome === "EXTRACTED" &&
            result.status === "NEEDS_CLARIFICATION"
          ) {
            issues = result.draft.ambiguityFlags.map(
              ({ field, reason }) => `${field}:${reason}`,
            );
            if (!issues.length) issues = ["Required domain fields are missing"];
            continue;
          }
          return result;
        } catch (error) {
          if (error instanceof ZodError || error instanceof SyntaxError) {
            issues =
              error instanceof ZodError
                ? error.issues.map(
                    ({ code, path }) => `${path.join(".")}:${code}`,
                  )
                : ["Malformed JSON output"];
            continue;
          }
          throw error;
        }
      }
      throw new MoleculeOpenAIError(
        "VALIDATION",
        `OpenAI output failed validation after retry (${issues.slice(0, 10).join(",").slice(0, 500)})`,
        false,
      );
    } catch (error) {
      if (error instanceof MoleculeOpenAIError) throw error;
      if (error instanceof OpenAI.AuthenticationError) {
        throw new MoleculeOpenAIError(
          "AUTH",
          "OpenAI authentication failed",
          false,
        );
      }
      if (error instanceof OpenAI.RateLimitError) {
        throw new MoleculeOpenAIError(
          "RATE_LIMIT",
          "OpenAI rate limited the request",
          true,
        );
      }
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new MoleculeOpenAIError(
          "TIMEOUT",
          "OpenAI request timed out",
          true,
        );
      }
      if (error instanceof OpenAI.APIError) {
        const status = error.status;
        const auth = status === 401 || status === 403;
        const retryable =
          status === undefined ||
          status === 408 ||
          status === 409 ||
          status >= 500;
        throw new MoleculeOpenAIError(
          auth ? "AUTH" : retryable ? "TRANSPORT" : "VALIDATION",
          auth
            ? "OpenAI authorization failed"
            : status === undefined
              ? "OpenAI connection failed"
              : `OpenAI request failed (${status})`,
          retryable,
          {
            status,
            code: error.code,
            type:
              error.error &&
              typeof error.error === "object" &&
              "type" in error.error
                ? error.error.type
                : undefined,
            message: safeProviderMessage(error),
          },
        );
      }
      if (error instanceof ZodError) {
        throw new MoleculeOpenAIError(
          "VALIDATION",
          "OpenAI output failed domain validation",
          false,
          { issues: error.issues.map(({ code }) => code) },
        );
      }
      throw new MoleculeOpenAIError(
        "TRANSPORT",
        "OpenAI request failed",
        true,
        {
          cause: error instanceof Error ? error.name : "unknown",
          message: safeProviderMessage(error),
        },
      );
    }
  }

  async clarifyBrief(
    input: BriefClarificationRequest,
  ): Promise<BriefClarificationResult> {
    const parsed = BriefClarificationRequestSchema.parse(input);
    const compileRequest = clarificationCompileRequest(parsed);
    const compiled = await this.compileIntent(compileRequest);
    const base = clarificationFromCompile(compiled, parsed);
    if (
      base.status !== "NEEDS_INPUT" ||
      compiled.status !== "NEEDS_CLARIFICATION"
    )
      return base;
    const pending = base.questions.filter(
      (question) => question.options.length === 0,
    );
    if (pending.length === 0) return base;
    const suggestions = await this.suggestOptions(
      compileRequest,
      pending.map(({ question, field, reason }) => ({
        question,
        field,
        reason: reason ?? null,
      })),
      compiled.draft,
    );
    return withSuggestedOptions(base, suggestions);
  }

  /** Second structured pass: propose answer choices. Failures degrade to free-text questions. */
  private async suggestOptions(
    request: CompileIntentRequest,
    questions: { question: string; field: string; reason: string | null }[],
    draft: ProductIntentDraft,
  ): Promise<SuggestedOptions> {
    const context = {
      customerText: request.text,
      locale: request.locale,
      partialIntent: {
        desiredOutputs: draft.desiredOutputs.map((output) => ({
          name: output.name,
          attributes: output.attributes,
        })),
        transformations: draft.transformations.map((step) => ({
          kind: step.kind,
          description: step.description,
        })),
        hardConstraints: draft.hardConstraints.map((rule) => ({
          field: rule.field,
          operator: rule.operator,
          value: rule.value,
        })),
      },
      questions,
    };
    try {
      const response = await this.client.responses.parse(
        {
          model: this.compilerModel,
          instructions: CLARIFICATION_SUGGESTER_INSTRUCTIONS,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: JSON.stringify(context) }],
            },
          ],
          text: {
            format: zodTextFormat(
              ClarificationSuggestionSchema,
              "clarification_options",
            ),
          },
          store: false,
          max_output_tokens: 2500,
          safety_identifier: createHash("sha256")
            .update(request.orderId)
            .digest("hex"),
          metadata: {
            trace_id: request.traceId,
            prompt_version: CLARIFICATION_PROMPT_VERSION,
          },
        },
        {
          timeout: this.options.timeoutMs ?? 25_000,
          headers: {
            "Idempotency-Key": createHash("sha256")
              .update(`${request.traceId}:clarify:${JSON.stringify(context)}`)
              .digest("hex"),
          },
        },
      );
      if (response.status !== "completed" || !response.output_parsed) return [];
      const suggestion = ClarificationSuggestionSchema.safeParse(
        response.output_parsed,
      );
      if (!suggestion.success) return [];
      return suggestion.data.questions.map((item) => ({
        question: item.question,
        options: item.options
          .filter((option) => option.label.trim() && option.value.trim())
          .map((option) => ({
            label: option.label.trim(),
            value: option.value.trim(),
            ...(option.hint?.trim() ? { hint: option.hint.trim() } : {}),
          })),
        ...(item.inputHint?.trim() ? { inputHint: item.inputHint.trim() } : {}),
      }));
    } catch (error) {
      if (
        error instanceof OpenAI.AuthenticationError ||
        (error instanceof OpenAI.APIError &&
          (error.status === 401 || error.status === 403))
      )
        throw new MoleculeOpenAIError(
          "AUTH",
          "OpenAI authentication failed",
          false,
        );
      return [];
    }
  }

  async mintRealtimeClientSecret(
    safetyIdentifier: string,
    profile?: "desktop",
  ): Promise<RealtimeClientSecret> {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": safetyIdentifier,
        },
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds: 120 },
          session: {
            type: "realtime",
            model: this.realtimeModel,
            instructions:
              profile === "desktop"
                ? DESKTOP_VOICE_INSTRUCTIONS
                : "You are Molecule's concise voice interface. Use tools for every order fact and action. Never claim feasibility unless get_order_status reports a VALID plan.",
            audio: {
              input: {
                transcription: {
                  model:
                    this.options.transcriptionModel?.trim() ||
                    "gpt-4o-mini-transcribe",
                },
                turn_detection: {
                  type: "semantic_vad",
                  eagerness: "low",
                  interrupt_response: true,
                  create_response: profile !== "desktop",
                },
              },
              output: { voice: "marin" },
            },
            tools:
              profile === "desktop"
                ? DESKTOP_VOICE_TOOLS
                : [
                    {
                      type: "function",
                      name: "compile_intent",
                      description:
                        "Compile the latest customer production request.",
                      parameters: {
                        type: "object",
                        properties: { text: { type: "string" } },
                        required: ["text"],
                        additionalProperties: false,
                      },
                    },
                    {
                      type: "function",
                      name: "update_constraint",
                      description:
                        "Apply a customer correction to the current intent.",
                      parameters: {
                        type: "object",
                        properties: {
                          text: { type: "string" },
                          kind: {
                            type: "string",
                            enum: [
                              "constraint",
                              "preference",
                              "quantity",
                              "deadline",
                              "budget",
                              "other",
                            ],
                          },
                        },
                        required: ["text", "kind"],
                        additionalProperties: false,
                      },
                    },
                    {
                      type: "function",
                      name: "get_order_status",
                      description:
                        "Get the authoritative current order state and plan summary.",
                      parameters: {
                        type: "object",
                        properties: {},
                        required: [],
                        additionalProperties: false,
                      },
                    },
                    {
                      type: "function",
                      name: "explain_current_plan",
                      description:
                        "Get concise, structured facts for narrating the current plan.",
                      parameters: {
                        type: "object",
                        properties: {},
                        required: [],
                        additionalProperties: false,
                      },
                    },
                    {
                      type: "function",
                      name: "approve_and_execute",
                      description:
                        "Approve and execute the currently active validated plan.",
                      parameters: {
                        type: "object",
                        properties: {},
                        required: [],
                        additionalProperties: false,
                      },
                    },
                    {
                      type: "function",
                      name: "trigger_demo_failure",
                      description:
                        "In demo mode, mark one current supplier offline.",
                      parameters: {
                        type: "object",
                        properties: { merchantId: { type: "string" } },
                        required: ["merchantId"],
                        additionalProperties: false,
                      },
                    },
                  ],
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new MoleculeOpenAIError(
        response.status === 401 ? "AUTH" : "TRANSPORT",
        `Realtime client secret request failed (${response.status})`,
        response.status >= 500 || response.status === 429,
      );
    }
    const data = (await response.json()) as {
      value?: string;
      expires_at?: number;
    };
    if (!data.value?.startsWith("ek_")) {
      throw new MoleculeOpenAIError(
        "VALIDATION",
        "Realtime response did not contain an ephemeral key",
        false,
      );
    }
    return { value: data.value, expiresAt: data.expires_at };
  }

  async uploadContext(input: {
    bytes: Uint8Array;
    name: string;
    mimeType: string;
    traceId: string;
    actionKey: string;
  }): Promise<string> {
    const file = await this.client.files.create(
      {
        file: await toFile(input.bytes, input.name, { type: input.mimeType }),
        purpose: "user_data",
      },
      {
        headers: { "Idempotency-Key": `${input.traceId}:${input.actionKey}` },
      },
    );
    return file.id;
  }

  async extractClaims(
    input: ClaimExtractionRequest,
  ): Promise<ClaimExtractionResult> {
    const request = ClaimExtractionRequestSchema.parse(input);
    try {
      const response = await this.client.responses.parse({
        model: this.compilerModel,
        instructions:
          "Extract only explicit merchant operational facts. Return candidate values with evidence and confidence. Preserve ambiguity. Do not resolve conflicts or create canonical claims.",
        input: JSON.stringify({
          merchantId: request.merchantId,
          locale: request.locale,
          text: request.text ?? null,
          assets: request.assets,
          source: request.source ?? null,
        }),
        text: {
          format: zodTextFormat(
            ClaimExtractionOutputSchema,
            "merchant_claim_candidates",
          ),
        },
        store: false,
        safety_identifier: createHash("sha256")
          .update(request.merchantId)
          .digest("hex"),
        metadata: { trace_id: request.traceId },
      });
      if (!response.output_parsed) {
        throw new MoleculeOpenAIError(
          "VALIDATION",
          "Claim extraction returned no parsed output",
          false,
        );
      }
      return ClaimExtractionResultSchema.parse({
        merchantId: request.merchantId,
        candidates: response.output_parsed.candidates,
      });
    } catch (error) {
      if (error instanceof MoleculeOpenAIError) throw error;
      if (error instanceof ZodError) {
        throw new MoleculeOpenAIError(
          "VALIDATION",
          "Claim extraction failed validation",
          false,
        );
      }
      throw new MoleculeOpenAIError(
        "TRANSPORT",
        "Claim extraction request failed",
        true,
      );
    }
  }
}
