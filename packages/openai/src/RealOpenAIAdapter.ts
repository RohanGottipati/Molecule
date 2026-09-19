import { createHash } from "node:crypto";

import {
  ClaimExtractionRequestSchema,
  ClaimExtractionResultSchema,
  CompileIntentRequestSchema,
  type ClaimExtractionRequest,
  type ClaimExtractionResult,
  type CompileIntentRequest,
  type CompileIntentResult,
} from "@molecule/contracts";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputContent } from "openai/resources/responses/responses";
import { ZodError } from "zod";

import { MoleculeOpenAIError } from "./errors.js";
import { mapExtractionToResult } from "./mapExtraction.js";
import type { OpenAIAdapter, RealtimeClientSecret } from "./OpenAIAdapter.js";
import {
  INTENT_COMPILER_INSTRUCTIONS,
  INTENT_PROMPT_VERSION,
} from "./prompts/intentCompiler.js";
import { IntentExtractionSchema } from "./schema/intentExtraction.js";
import { ClaimExtractionOutputSchema } from "./schema/claimExtraction.js";

export interface RealOpenAIAdapterOptions {
  apiKey: string;
  compilerModel?: string;
  realtimeModel?: string;
  timeoutMs?: number;
  client?: OpenAI;
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
    this.compilerModel = options.compilerModel ?? "gpt-5.6-terra";
    this.realtimeModel = options.realtimeModel ?? "gpt-realtime-2.1";
  }

  async compileIntent(
    input: CompileIntentRequest,
  ): Promise<CompileIntentResult> {
    const parsedInput = CompileIntentRequestSchema.parse(input);
    const safetyIdentifier = createHash("sha256")
      .update(parsedInput.orderId)
      .digest("hex");
    const context = {
      requestTimestamp: parsedInput.requestedAt,
      locale: parsedInput.locale,
      timeZone: parsedInput.timeZone,
      customerText: parsedInput.text,
      correction: parsedInput.correction ?? null,
      previousIntent: parsedInput.previousIntent ?? null,
      assets: parsedInput.assets,
    };

    try {
      let issues: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const assetContent: ResponseInputContent[] = [];
        for (const asset of parsedInput.assets) {
          if (!asset.url) continue;
          if (asset.mimeType?.startsWith("image/")) {
            assetContent.push({
              type: "input_image",
              image_url: asset.url,
              detail: "auto",
            });
          } else {
            assetContent.push({
              type: "input_file",
              file_url: asset.url,
            });
          }
        }
        const response = await this.client.responses.parse({
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
          safety_identifier: safetyIdentifier,
          metadata: {
            trace_id: parsedInput.traceId,
            prompt_version: INTENT_PROMPT_VERSION,
          },
        });

        if (response.status === "incomplete") {
          throw new MoleculeOpenAIError(
            "INCOMPLETE",
            `OpenAI response incomplete: ${response.incomplete_details?.reason ?? "unknown"}`,
            response.incomplete_details?.reason === "max_output_tokens",
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

        return mapExtractionToResult(
          extraction.data,
          parsedInput.previousIntent,
          parsedInput.assets,
        );
      }
      throw new MoleculeOpenAIError(
        "VALIDATION",
        `OpenAI output failed validation after retry (${issues.join(",")})`,
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
        { cause: error instanceof Error ? error.name : "unknown" },
      );
    }
  }

  async mintRealtimeClientSecret(
    safetyIdentifier: string,
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
              "You are Molecule's concise voice interface. Use tools for every order fact and action. Never claim feasibility unless get_order_status reports a VALID plan.",
            audio: { output: { voice: "marin" } },
            tools: [
              {
                type: "function",
                name: "compile_intent",
                description: "Compile the latest customer production request.",
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
                description: "In demo mode, mark one current supplier offline.",
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
