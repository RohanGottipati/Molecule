import {
  INITIAL_CATALOG_CATEGORIES,
  validateCatalogJsonl,
  type CatalogRecord,
} from "./index.js";

export type DeliveryReviewProfile = "sample" | "recipe-set";

/** An intake report, never a feasibility certificate or permission to activate. */
export function reviewCatalogDelivery(
  jsonl: string,
  profile: DeliveryReviewProfile = "sample",
) {
  const validated = validateCatalogJsonl(jsonl);
  const records = validated.records;
  const recipes = records.filter((record) => record.recordType === "recipe");
  const minimumRecipes = profile === "sample" ? 20 : 100;
  const minimumIndividualsPerCategory = profile === "sample" ? 1 : 8;
  const definitionErrors: string[] = [];
  if (recipes.length < minimumRecipes) {
    definitionErrors.push(
      `INSUFFICIENT_RECIPES: expected at least ${minimumRecipes}, received ${recipes.length}`,
    );
  }
  const coverage = INITIAL_CATALOG_CATEGORIES.map((category) => {
    const individualRecipes = recipes.filter(
      (recipe) =>
        recipe.category === category &&
        recipe.expected.outputKind === "individual",
    ).length;
    const bundles = recipes.filter(
      (recipe) =>
        recipe.category === category && recipe.expected.outputKind === "bundle",
    ).length;
    const source = validated.coverage.find((row) => row.category === category);
    if (individualRecipes < minimumIndividualsPerCategory) {
      definitionErrors.push(
        `CATEGORY_RECIPE_GAP ${category}: expected ${minimumIndividualsPerCategory} individual recipes, received ${individualRecipes}`,
      );
    }
    if (!source?.products)
      definitionErrors.push(`CATEGORY_PRODUCT_GAP ${category}`);
    return {
      category,
      products: source?.products ?? 0,
      individualRecipes,
      bundles,
      // Suppress the validator's provisional readiness counts for invalid graphs.
      bindingsWithResolvedEvidence: validated.errors.length
        ? 0
        : (source?.readyBindings ?? 0),
    };
  });
  if (profile === "recipe-set") {
    const bundles = recipes.filter(
      (recipe) => recipe.expected.outputKind === "bundle",
    );
    if (bundles.length < 4)
      definitionErrors.push("BUNDLE_RECIPE_GAP: expected at least 4 bundles");
    if (
      !bundles.some((recipe) => recipe.expected.minimumDistinctSuppliers >= 7)
    ) {
      definitionErrors.push(
        "SHOWCASE_DEFINITION_GAP: a bundle must require at least 7 distinct suppliers",
      );
    }
  }

  const recordCounts: Record<string, number> = {};
  const unresolvedFacts: {
    recordId: string;
    field: string;
    status: "unknown" | "conflicted";
  }[] = [];
  for (const record of records) {
    recordCounts[record.recordType] =
      (recordCounts[record.recordType] ?? 0) + 1;
    if (record.recordType === "fact" && record.assertion.status !== "known") {
      unresolvedFacts.push({
        recordId: record.id,
        field: record.field,
        status: record.assertion.status,
      });
    }
    if (record.recordType === "variant" && record.material.status !== "known") {
      unresolvedFacts.push({
        recordId: record.id,
        field: "material",
        status: record.material.status,
      });
    }
    if (
      record.recordType === "resource" &&
      record.availability.status !== "known"
    ) {
      unresolvedFacts.push({
        recordId: record.id,
        field: "availability",
        status: record.availability.status,
      });
    }
  }
  // Structural signatures flag likely color/size/text-only padding for human review.
  // They do not replace the solver's product/material/operation compatibility checks.
  const signatures = new Map<string, string[]>();
  for (const recipe of recipes) {
    const signature = recipeSignature(recipe);
    signatures.set(signature, [
      ...(signatures.get(signature) ?? []),
      recipe.id,
    ]);
  }
  const possibleDuplicateRecipes = [...signatures.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ids.sort())
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  const exclusions = validated.exclusions.filter(
    (entry) => entry.reasons.length > 0,
  );
  const evidenceReviewRequired =
    unresolvedFacts.length > 0 ||
    exclusions.length > 0 ||
    coverage.some((row) => row.bindingsWithResolvedEvidence === 0);
  const status = validated.errors.length
    ? "INVALID_DELIVERY"
    : definitionErrors.length
      ? "INCOMPLETE_SAMPLE_DEFINITIONS"
      : evidenceReviewRequired || possibleDuplicateRecipes.length
        ? "REVIEW_REQUIRED"
        : "READY_FOR_INTEGRATION_REVIEW";

  return {
    reportVersion: 1,
    profile,
    catalogVersion: validated.manifest?.catalogVersion ?? null,
    status,
    structurallyValid: validated.errors.length === 0,
    solverCertified: false,
    databaseImported: false,
    liveExecutionVerified: false,
    recordCounts: Object.fromEntries(
      Object.entries(recordCounts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    evidence: {
      syntheticRecords: records.filter((record) => record.evidence.synthetic)
        .length,
      nonSyntheticRecords: records.filter(
        (record) => !record.evidence.synthetic,
      ).length,
      unresolvedFacts: unresolvedFacts.sort((a, b) =>
        a.recordId.localeCompare(b.recordId),
      ),
    },
    taxonomy: {
      suppliedCategories: validated.manifest?.categories ?? [],
      targetLabelCount: 32,
      additionalLabelsNeeded: Math.max(
        0,
        32 - (validated.manifest?.categories.length ?? 0),
      ),
    },
    errors: validated.errors,
    definitionErrors,
    exclusions,
    possibleDuplicateRecipes,
    coverage,
    nextStep:
      status === "READY_FOR_INTEGRATION_REVIEW"
        ? "Run isolated database ingestion and actual Python solver acceptance; this report does not certify feasibility."
        : "Resolve the listed data, sample-definition and evidence review items before acceptance.",
  };
}

type Recipe = Extract<CatalogRecord, { recordType: "recipe" }>;

function recipeSignature(recipe: Recipe): string {
  const ignoredAttributes = new Set([
    "color",
    "colour",
    "size",
    "text",
    "wording",
    "personalization",
    "personalisation",
  ]);
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  const outputs = recipe.intent.desiredOutputs.map((output) => ({
    product: output.attributes.product ?? output.name,
    attributes: Object.fromEntries(
      Object.entries(output.attributes).filter(
        ([key]) => !ignoredAttributes.has(key.toLowerCase()),
      ),
    ),
  }));
  const refs = new Map(
    recipe.intent.desiredOutputs.map((output, index) => [
      output.outputId,
      canonical(outputs[index]),
    ]),
  );
  // Keep stage order and edges while ignoring arbitrary local ID spellings.
  for (const [index, stage] of recipe.intent.transformations.entries()) {
    for (const [port, ref] of stage.outputRefs.entries())
      refs.set(ref, `stage:${index}:port:${port}`);
  }
  return canonical({
    kind: recipe.expected.outputKind,
    outputs: outputs.map(canonical).sort(),
    stages: recipe.intent.transformations.map((stage) => ({
      kind: stage.kind,
      inputs: stage.inputRefs
        .map((ref) => refs.get(ref) ?? `unresolved:${ref}`)
        .sort(),
      outputCount: stage.outputRefs.length,
    })),
  });
}

export type DeliveryReview = ReturnType<typeof reviewCatalogDelivery>;
