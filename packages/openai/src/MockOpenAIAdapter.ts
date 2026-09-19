import type {
  ClaimExtractionRequest,
  ClaimExtractionResult,
  CompileIntentRequest,
  CompileIntentResult,
  ProductIntentDraft,
} from "@molecule/contracts";

import type { OpenAIAdapter } from "./OpenAIAdapter.js";
import { mockExtractClaims } from "./extractClaims.js";
import { mapExtractionToResult } from "./mapExtraction.js";
import type { IntentExtraction } from "./schema/intentExtraction.js";

function numericMatch(text: string, pattern: RegExp): number | null {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? null : Number(value.replaceAll(",", ""));
}

function makeExtraction(
  input: CompileIntentRequest,
  previous: ProductIntentDraft | undefined,
): IntentExtraction {
  const text = input.text.toLowerCase();
  const quantity =
    numericMatch(
      text,
      /(?:quantity|qty|make|need|want)\s*(?:of\s*)?(\d[\d,]*)/,
    ) ??
    numericMatch(text, /(\d[\d,]*)\s+(?:black\s+)?(?:hoodies|bottles|kits)/) ??
    previous?.quantity ??
    null;
  const budget =
    numericMatch(
      text,
      /(?:budget|max(?:imum)?|under)\s*\$?([\d,]+(?:\.\d+)?)/,
    ) ??
    previous?.budgetMax ??
    null;
  const isoDeadline =
    /20\d\d-\d\d-\d\d(?:t\d\d:\d\d(?::\d\d(?:\.\d+)?)?z)?/i.exec(
      input.text,
    )?.[0];
  const deadline = isoDeadline
    ? new Date(
        isoDeadline.includes("T")
          ? isoDeadline
          : `${isoDeadline}T23:59:59.000Z`,
      ).toISOString()
    : (previous?.deadline ?? null);
  const currency = text.includes("usd")
    ? "USD"
    : text.includes("cad")
      ? "CAD"
      : (previous?.currency ?? null);

  const hasHoodie = Boolean(
    text.includes("hoodie") ||
    previous?.desiredOutputs.some(({ name }) =>
      name.toLowerCase().includes("hoodie"),
    ),
  );
  const hasBottle = Boolean(
    text.includes("bottle") ||
    previous?.desiredOutputs.some(({ name }) =>
      name.toLowerCase().includes("bottle"),
    ),
  );
  const hasKit = Boolean(
    text.includes("kit") ||
    previous?.desiredOutputs.some(({ name }) =>
      name.toLowerCase().includes("kit"),
    ),
  );
  const desiredOutputs = [
    ...(hasHoodie
      ? [{ key: "hoodie", name: "Hoodie", quantity, attributes: [] }]
      : []),
    ...(hasBottle
      ? [{ key: "bottle", name: "Bottle", quantity, attributes: [] }]
      : []),
    ...(hasKit
      ? [{ key: "kit", name: "Onboarding kit", quantity, attributes: [] }]
      : []),
  ];
  const noPolyester = text.includes("no polyester");
  const inheritedEmbroidery = Boolean(
    previous?.transformations.some(({ kind }) => /embroider/i.test(kind)),
  );
  const inheritedEngraving = Boolean(
    previous?.transformations.some(({ kind }) => /engrav/i.test(kind)),
  );
  const inheritedHard =
    previous?.hardConstraints.map((constraint, index) => ({
      key: `previous-${constraint.field}-${index}`,
      field: constraint.field,
      operator: constraint.operator,
      value: constraint.value as
        string | number | boolean | string[] | number[],
      unit: constraint.unit ?? null,
      description: constraint.description ?? null,
    })) ?? [];
  const hardConstraints = [
    ...inheritedHard.filter(
      ({ field }) => field !== "material" || !noPolyester,
    ),
    ...(noPolyester
      ? [
          {
            key: "material-no-polyester",
            field: "material",
            operator: "neq" as const,
            value: "polyester",
            unit: null,
            description: "Polyester is not allowed",
          },
        ]
      : []),
  ];
  const transformations = [
    ...(text.includes("embroider") || inheritedEmbroidery
      ? [
          {
            key: "embroidery",
            kind: "embroidery",
            description: "Embroider supplied artwork",
            inputKeys: ["hoodie"],
            outputKeys: ["hoodie"],
          },
        ]
      : []),
    ...(text.includes("engrave") || inheritedEngraving
      ? [
          {
            key: "engraving",
            kind: "engraving",
            description: "Engrave supplied artwork",
            inputKeys: ["bottle"],
            outputKeys: ["bottle"],
          },
        ]
      : []),
    ...(hasKit
      ? [
          {
            key: "assembly",
            kind: "assembly",
            description: "Assemble and package the kit",
            inputKeys: ["hoodie", "bottle"],
            outputKeys: ["kit"],
          },
        ]
      : []),
  ];
  const ambiguityFlags = [
    ...(quantity === null
      ? [
          {
            field: "quantity",
            reason: "missing",
            question: "How many units do you need?",
          },
        ]
      : []),
    ...(deadline === null
      ? [
          {
            field: "deadline",
            reason: "missing",
            question: "What is the required delivery deadline?",
          },
        ]
      : []),
    ...(currency === null
      ? [
          {
            field: "currency",
            reason: "missing",
            question: "Should the order be priced in CAD or USD?",
          },
        ]
      : []),
    ...(desiredOutputs.length === 0
      ? [
          {
            field: "desiredOutputs",
            reason: "missing",
            question: "What product should be made?",
          },
        ]
      : []),
  ];

  return {
    outcome: ambiguityFlags.length > 0 ? "NEEDS_CLARIFICATION" : "EXTRACTED",
    unsupportedReason: null,
    quantity,
    deadline,
    currency,
    budgetMax: budget,
    desiredOutputs,
    transformations,
    hardConstraints,
    softPreferences: [],
    ambiguityFlags,
  };
}

export class MockOpenAIAdapter implements OpenAIAdapter {
  async compileIntent(
    input: CompileIntentRequest,
  ): Promise<CompileIntentResult> {
    return mapExtractionToResult(
      makeExtraction(input, input.previousIntent),
      input.previousIntent,
      input.assets,
    );
  }

  async extractClaims(
    input: ClaimExtractionRequest,
  ): Promise<ClaimExtractionResult> {
    return mockExtractClaims(input);
  }
}
