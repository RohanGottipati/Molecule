import { createHash, randomUUID } from "node:crypto";

import {
  CompileIntentResultSchema,
  ProductIntentDraftSchema,
  ProductIntentSchema,
  type AssetRef,
  type CompileIntentResult,
  type ProductIntentDraft,
} from "@molecule/contracts";

import type { IntentExtraction } from "./schema/intentExtraction.js";

function stableId(intentId: string, kind: string, key: string): string {
  return `${kind}-${createHash("sha256")
    .update(`${intentId}:${kind}:${key}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function attributesFrom(
  values: Array<{ name: string; value: unknown }>,
): Record<string, unknown> {
  return Object.fromEntries(values.map(({ name, value }) => [name, value]));
}

export function mapExtractionToResult(
  extraction: IntentExtraction,
  previousIntent: ProductIntentDraft | undefined,
  assets: AssetRef[],
): CompileIntentResult {
  if (extraction.outcome === "UNSUPPORTED") {
    return CompileIntentResultSchema.parse({
      status: "UNSUPPORTED",
      reason:
        extraction.unsupportedReason ?? "The request cannot be fulfilled.",
    });
  }

  const intentId = previousIntent?.intentId ?? randomUUID();
  const version = (previousIntent?.version ?? 0) + 1;
  const keyToOutputId = new Map(
    extraction.desiredOutputs.map(({ key }) => [
      key,
      stableId(intentId, "output", key),
    ]),
  );

  const draft = ProductIntentDraftSchema.parse({
    intentId,
    version,
    quantity: extraction.quantity,
    deadline: extraction.deadline,
    currency: extraction.currency,
    budgetMax: extraction.budgetMax,
    desiredOutputs: extraction.desiredOutputs.map((output) => ({
      outputId: keyToOutputId.get(output.key)!,
      name: output.name,
      quantity: output.quantity ?? undefined,
      attributes: attributesFrom(output.attributes),
    })),
    transformations: extraction.transformations.map((transformation) => ({
      transformationId: stableId(
        intentId,
        "transformation",
        transformation.key,
      ),
      kind: transformation.kind,
      description: transformation.description,
      inputRefs: transformation.inputKeys.map(
        (key) => keyToOutputId.get(key) ?? stableId(intentId, "port", key),
      ),
      outputRefs: transformation.outputKeys.map(
        (key) => keyToOutputId.get(key) ?? stableId(intentId, "port", key),
      ),
    })),
    hardConstraints: extraction.hardConstraints.map((constraint) => ({
      constraintId: stableId(intentId, "constraint", constraint.key),
      field: constraint.field,
      operator: constraint.operator,
      value: constraint.value,
      unit: constraint.unit ?? undefined,
      description: constraint.description ?? undefined,
    })),
    softPreferences: extraction.softPreferences.map((preference) => ({
      constraintId: stableId(intentId, "preference", preference.key),
      field: preference.field,
      operator: preference.operator,
      value: preference.value,
      unit: preference.unit ?? undefined,
      description: preference.description ?? undefined,
      weight: preference.weight,
    })),
    assets,
    ambiguityFlags: extraction.ambiguityFlags,
  });

  const questions = draft.ambiguityFlags
    .map(({ question }) => question)
    .filter((question): question is string => Boolean(question));
  const complete = ProductIntentSchema.safeParse({
    ...draft,
    budgetMax: draft.budgetMax ?? undefined,
  });

  if (
    extraction.outcome === "NEEDS_CLARIFICATION" ||
    !complete.success ||
    questions.length > 0
  ) {
    return CompileIntentResultSchema.parse({
      status: "NEEDS_CLARIFICATION",
      draft,
      questions:
        questions.length > 0
          ? questions
          : ["Please clarify the missing product requirements."],
    });
  }

  return CompileIntentResultSchema.parse({
    status: "READY",
    intent: complete.data,
  });
}
