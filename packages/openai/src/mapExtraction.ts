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
    extraction.desiredOutputs.map(({ key, name }) => {
      const exact = previousIntent?.desiredOutputs.find(
        (output) => output.outputId === key,
      );
      const matches =
        previousIntent?.desiredOutputs.filter(
          (output) => output.name === name || output.attributes.product === key,
        ) ?? [];
      const previous = exact ?? (matches.length === 1 ? matches[0] : undefined);
      return [key, previous?.outputId ?? key];
    }),
  );
  const constraintId = (
    key: string,
    rule: Pick<
      ProductIntentDraft["hardConstraints"][number],
      "field" | "operator" | "value"
    >,
    kind: string,
  ) =>
    [
      ...(previousIntent?.hardConstraints ?? []),
      ...(previousIntent?.softPreferences ?? []),
    ].find(
      (previous) =>
        previous.constraintId === key ||
        (previous.field === rule.field &&
          previous.operator === rule.operator &&
          JSON.stringify(previous.value) === JSON.stringify(rule.value)),
    )?.constraintId ?? stableId(intentId, kind, key);
  const outputs = extraction.desiredOutputs.map((output) => {
    const previous = previousIntent?.desiredOutputs.find(
      (item) => item.outputId === keyToOutputId.get(output.key),
    );
    return {
      outputId: keyToOutputId.get(output.key)!,
      name: output.name,
      quantity: output.quantity ?? previous?.quantity,
      attributes: {
        ...previous?.attributes,
        ...attributesFrom(output.attributes),
      },
    };
  });
  const transformations = extraction.transformations.map((transformation) => {
    const inputRefs = transformation.inputKeys.map(
      (key) => keyToOutputId.get(key) ?? key,
    );
    const previous = previousIntent?.transformations.find(
      (item) =>
        item.transformationId === transformation.key ||
        (item.kind === transformation.kind &&
          JSON.stringify(item.inputRefs) === JSON.stringify(inputRefs)),
    );
    return {
      transformationId: previous?.transformationId ?? transformation.key,
      kind: transformation.kind,
      description: transformation.description,
      inputRefs,
      outputRefs: transformation.outputKeys.map(
        (key) => keyToOutputId.get(key) ?? key,
      ),
    };
  });
  const hardConstraints = extraction.hardConstraints.map((constraint) => ({
    constraintId: constraintId(constraint.key, constraint, "constraint"),
    field: constraint.field,
    operator: constraint.operator,
    value: constraint.value,
    unit: constraint.unit ?? undefined,
    description: constraint.description ?? undefined,
  }));
  const preferences = extraction.softPreferences.map((preference) => ({
    constraintId: constraintId(preference.key, preference, "preference"),
    field: preference.field,
    operator: preference.operator,
    value: preference.value,
    unit: preference.unit ?? undefined,
    description: preference.description ?? undefined,
    weight: preference.weight,
  }));

  const draft = ProductIntentDraftSchema.parse({
    intentId,
    version,
    quantity: extraction.quantity ?? previousIntent?.quantity ?? null,
    deadline: extraction.deadline ?? previousIntent?.deadline ?? null,
    currency: extraction.currency ?? previousIntent?.currency ?? null,
    budgetMax: extraction.budgetMax ?? previousIntent?.budgetMax ?? null,
    desiredOutputs: [
      ...(previousIntent?.desiredOutputs.filter(
        (old) => !outputs.some((item) => item.outputId === old.outputId),
      ) ?? []),
      ...outputs,
    ],
    transformations: [
      ...(previousIntent?.transformations.filter(
        (old) =>
          !transformations.some(
            (item) => item.transformationId === old.transformationId,
          ),
      ) ?? []),
      ...transformations,
    ],
    hardConstraints: [
      ...(previousIntent?.hardConstraints.filter(
        (old) =>
          !hardConstraints.some(
            (item) =>
              item.constraintId === old.constraintId ||
              (item.field === old.field &&
                item.operator === "eq" &&
                old.operator === "eq"),
          ),
      ) ?? []),
      ...hardConstraints,
    ],
    softPreferences: [
      ...(previousIntent?.softPreferences.filter(
        (old) =>
          !preferences.some((item) => item.constraintId === old.constraintId),
      ) ?? []),
      ...preferences,
    ],
    assets: [
      ...new Map(
        [...(previousIntent?.assets ?? []), ...assets].map((asset) => [
          asset.assetId,
          asset,
        ]),
      ).values(),
    ],
    ambiguityFlags: extraction.ambiguityFlags,
  });
  const graphIssues = intentGraphIssues(draft);
  draft.ambiguityFlags.push(
    ...graphIssues.map((reason) => ({
      field: "transformations",
      reason,
      question: "Please clarify the components and their production steps.",
    })),
  );

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

export function intentGraphIssues(intent: ProductIntentDraft): string[] {
  const producers = new Map<string, string>();
  const requirements = new Set<string>();
  const edges = new Map<string, string[]>();
  const issues: string[] = [];
  for (const output of intent.desiredOutputs) {
    if (producers.has(output.outputId)) issues.push("Duplicate component ID");
    producers.set(output.outputId, output.outputId);
    requirements.add(output.outputId);
  }
  for (const transformation of intent.transformations) {
    if (requirements.has(transformation.transformationId))
      issues.push("Duplicate requirement ID");
    requirements.add(transformation.transformationId);
    if (!transformation.inputRefs.length || !transformation.outputRefs.length)
      issues.push("Missing transformation references");
    for (const ref of transformation.outputRefs) {
      if (producers.has(ref))
        issues.push("Each output needs a unique producer and stage reference");
      producers.set(ref, transformation.transformationId);
    }
  }
  const consumed = new Set<string>();
  for (const transformation of intent.transformations) {
    const dependencies: string[] = [];
    for (const ref of transformation.inputRefs) {
      const producer = producers.get(ref);
      if (!producer) issues.push("A component reference has no producer");
      else dependencies.push(producer);
      if (consumed.has(ref))
        issues.push("A component is consumed more than once");
      consumed.add(ref);
    }
    edges.set(transformation.transformationId, dependencies);
  }
  const pending = new Set(requirements);
  while (pending.size) {
    const ready = [...pending].filter((key) =>
      (edges.get(key) ?? []).every((source) => !pending.has(source)),
    );
    if (!ready.length) {
      issues.push("Production steps contain a cycle");
      break;
    }
    ready.forEach((key) => pending.delete(key));
  }
  return [...new Set(issues)];
}
