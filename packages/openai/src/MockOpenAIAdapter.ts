import {
  CompileIntentRequestSchema,
  type ClaimExtractionRequest,
  type ClaimExtractionResult,
  type CompileIntentRequest,
  type CompileIntentResult,
} from "@molecule/contracts";

import type { OpenAIAdapter } from "./OpenAIAdapter.js";
import { mockExtractClaims } from "./extractClaims.js";
import { mapExtractionToResult } from "./mapExtraction.js";
import { relativeDeadline } from "./relativeDate.js";
import {
  ExtractionValueSchema,
  type IntentExtraction,
} from "./schema/intentExtraction.js";

const products = [
  ["hoodie", "Hoodie", "hoodies?"],
  ["bottle", "Bottle", "bottles?"],
  ["snacks", "Snacks", "snacks?"],
  ["shirt", "Shirt", "(?:t-)?shirts?"],
  ["tote", "Tote", "totes?(?: bags?)?"],
  ["mug", "Mug", "mugs?"],
  ["notebook", "Notebook", "notebooks?"],
  ["hat", "Hat", "hats?"],
  ["jacket", "Jacket", "jackets?"],
] as const;

const sentenceBoundary = /[!?;\r\n]+|\.(?!\d)/;

function numericMatch(text: string, pattern: RegExp): number | null {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? null : Number(value.replaceAll(",", ""));
}

function makeExtraction(input: CompileIntentRequest): IntentExtraction {
  const previous = input.previousIntent;
  const text = `${input.text}\n${input.correction?.text ?? ""}`.toLowerCase();
  const ambiguityFlags: IntentExtraction["ambiguityFlags"] = [];
  const softPreferences: IntentExtraction["softPreferences"] = [];
  const explicitQuantity = numericMatch(
    text,
    /(?:quantity|qty|make|need|want)\s*(?:of\s*)?(\d[\d,]*)/,
  );
  const kitQuantity = numericMatch(
    text,
    /(\d[\d,]*)\s+(?:[\w-]+\s+){0,4}kits?\b/,
  );
  const firstQuantity = numericMatch(
    text,
    new RegExp(
      `(\\d[\\d,]*)\\s+(?:[\\w-]+\\s+){0,3}(?:${products.map((p) => p[2]).join("|")})\\b`,
    ),
  );
  const quantity =
    kitQuantity ??
    explicitQuantity ??
    firstQuantity ??
    previous?.quantity ??
    null;
  const budget =
    numericMatch(
      text,
      /(?:budget(?:\s+(?:of|is))?|max(?:imum)?|under)\s*(?:cad|usd)?\s*\$?([\d,]+(?:\.\d+)?)/,
    ) ??
    previous?.budgetMax ??
    null;
  const iso =
    /20\d\d-\d\d-\d\d(?:t\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:z|[+-]\d\d:\d\d))?/i.exec(
      text,
    )?.[0];
  let deadline = previous?.deadline ?? null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
    if (iso) {
      deadline = new Date(
        iso.includes("t") ? iso : `${iso}T23:59:59.000Z`,
      ).toISOString();
    } else {
      deadline =
        relativeDeadline(text, input.requestedAt, input.timeZone) ?? deadline;
    }
  } catch {
    ambiguityFlags.push({
      field: "deadline",
      reason: "invalid date or time zone",
      question: "What is the delivery date and IANA time zone?",
    });
  }
  const currency = /\busd\b/.test(text)
    ? "USD"
    : /\bcad\b/.test(text)
      ? "CAD"
      : (previous?.currency ?? null);
  if (/\busd\b/.test(text) && /\bcad\b/.test(text)) {
    ambiguityFlags.push({
      field: "currency",
      reason: "conflicting currencies",
      question: "Should the budget and quotes use CAD or USD?",
    });
  }
  const desiredOutputs: IntentExtraction["desiredOutputs"] = (
    previous?.desiredOutputs ?? []
  ).map((output) => ({
    key: output.outputId,
    name: output.name,
    quantity:
      quantity !== previous?.quantity && output.quantity === previous?.quantity
        ? quantity
        : (output.quantity ?? null),
    attributes: Object.entries(output.attributes).flatMap(([name, value]) => {
      const parsed = ExtractionValueSchema.safeParse(value);
      if (parsed.success) return [{ name, value: parsed.data }];
      ambiguityFlags.push({
        field: `${output.outputId}.${name}`,
        reason: "unresolved attribute",
        question: `What is the confirmed ${name} for ${output.name}?`,
      });
      return [];
    }),
  }));
  const hardConstraints: IntentExtraction["hardConstraints"] = (
    previous?.hardConstraints ?? []
  ).flatMap((rule) => {
    const parsed = ExtractionValueSchema.safeParse(rule.value);
    if (!parsed.success) {
      ambiguityFlags.push({
        field: rule.field,
        reason: "unresolved constraint",
        question: `What is the confirmed requirement for ${rule.field}?`,
      });
      return [];
    }
    return [
      {
        key: rule.constraintId,
        field: rule.field,
        operator: rule.operator,
        value: parsed.data,
        unit: rule.unit ?? null,
        description: rule.description ?? null,
      },
    ];
  });
  const addRule = (
    field: string,
    value: string,
    operator: "eq" | "not_contains" = "eq",
  ) => {
    if (operator === "eq") {
      for (let i = hardConstraints.length - 1; i >= 0; i -= 1) {
        if (
          hardConstraints[i]?.field === field &&
          hardConstraints[i]?.operator === "eq"
        )
          hardConstraints.splice(i, 1);
      }
    }
    if (
      !hardConstraints.some(
        (rule) =>
          rule.field === field &&
          rule.operator === operator &&
          rule.value === value,
      )
    ) {
      hardConstraints.push({
        key: `${field}-${operator}-${value}`,
        field,
        operator,
        value,
        unit: null,
        description: null,
      });
    }
  };
  const hasKit =
    /\bkits?\b/.test(text) ||
    previous?.transformations.some((t) => t.kind === "assembly");
  for (const [product, name, pattern] of products) {
    if (!new RegExp(`\\b${pattern}\\b`).test(text)) continue;
    const mention = new RegExp(`\\b${pattern}\\b`).exec(text);
    const prefix = text
      .slice(0, mention?.index)
      .split(sentenceBoundary)
      .at(-1)
      ?.split(/,|\band\b/)
      .at(-1)
      ?.trim()
      .split(/\s+/)
      .at(-1);
    if (
      prefix &&
      !/^(?:\d[\d,]*|a|an|the|some|make|need|want|of|with|include|including|black|white|red|blue|green|cotton|polyester|leather|steel|glass|vegan|premium|embroidered|engraved|printed|named)$/.test(
        prefix,
      )
    ) {
      ambiguityFlags.push({
        field: `${product}.attributes`,
        reason: "unrecognized mock attribute",
        question: `What measurable requirement does "${prefix}" specify for ${name}?`,
      });
    }
    let output = desiredOutputs.find(
      (item) =>
        item.key === product ||
        item.name === name ||
        item.attributes.some(
          (attribute) =>
            attribute.name === "product" && attribute.value === product,
        ),
    );
    if (!output) {
      output = {
        key: product,
        name,
        quantity,
        attributes: [{ name: "product", value: product }],
      };
      desiredOutputs.push(output);
    }
    const componentQuantity = numericMatch(
      text,
      new RegExp(
        `(\\d[\\d,]*)\\s+(?:black\\s+|vegan\\s+|cotton\\s+)?${pattern}\\b`,
      ),
    );
    if (componentQuantity !== null) output.quantity = componentQuantity;
    for (const [field, values] of [
      ["color", ["black", "white", "red", "blue", "green"]],
      [
        "material",
        ["cotton", "polyester", "leather", "stainless steel", "glass"],
      ],
      ["diet", ["vegan"]],
    ] as const) {
      const value = values.find((value) =>
        new RegExp(
          `\\b${value}\\s+(?:(?:cotton|polyester|leather|stainless steel|glass|black|white|red|blue|green|vegan|premium|embroidered|engraved|printed)\\s+){0,3}${pattern}\\b`,
        ).test(text),
      );
      if (value && !new RegExp(`\\b(?:no|without)\\s+${value}\\b`).test(text)) {
        const clause = text
          .split(sentenceBoundary)
          .flatMap((sentence) => sentence.split(/,|\band\b|\bbut\b/))
          .find(
            (clause) =>
              clause.includes(value) &&
              new RegExp(`\\b${pattern}\\b`).test(clause),
          );
        if (clause && /\b(?:prefer|ideally|would like)\b/.test(clause)) {
          softPreferences.push({
            key: `${product}.${field}-${value}`,
            field: `${product}.${field}`,
            operator: "eq",
            value,
            unit: null,
            description: null,
            weight: 0.5,
          });
          continue;
        }
        addRule(`${product}.${field}`, value);
        output.attributes = [
          ...output.attributes.filter((a) => a.name !== field),
          { name: field, value },
        ];
      }
    }
  }
  if (hasKit && desiredOutputs.length === 0) {
    desiredOutputs.push({
      key: "kit",
      name: "Onboarding kit",
      quantity,
      attributes: [{ name: "product", value: "kit" }],
    });
  }
  if (
    hasKit &&
    /\bblack\b/.test(text) &&
    desiredOutputs.some((o) => o.name === "Hoodie")
  ) {
    addRule("hoodie.color", "black");
    const hoodie = desiredOutputs.find((o) => o.name === "Hoodie")!;
    hoodie.attributes = [
      ...hoodie.attributes.filter((a) => a.name !== "color"),
      { name: "color", value: "black" },
    ];
  }
  for (const material of ["leather", "polyester"]) {
    if (new RegExp(`\\b(?:no|without|exclude)\\s+${material}\\b`).test(text))
      addRule("material", material, "not_contains");
  }
  const transformations: IntentExtraction["transformations"] = (
    previous?.transformations ?? []
  ).map((t) => ({
    key: t.transformationId,
    kind: t.kind,
    description: t.description,
    inputKeys: t.inputRefs,
    outputKeys: t.outputRefs,
  }));
  for (const [word, kind, result] of [
    ["embroider", "embroidery", "embroidered"],
    ["engrav", "engraving", "engraved"],
    ["print", "printing", "printed"],
  ] as const) {
    if (!text.includes(word)) continue;
    const matched = products.filter(([, , pattern]) =>
      new RegExp(
        `(?:\\b${pattern}\\s+(?:(?:logo|with|name|named|individual|supplied|artwork|the)\\s+){0,3}${word}\\w*\\b|\\b${word}\\w*\\s+(?:(?:logo|with|name|named|individual|supplied|artwork|the)\\s+){0,3}${pattern}\\b)`,
      ).test(text),
    );
    const targets = matched.length
      ? desiredOutputs.filter((o) =>
          matched.some(([, name]) => o.name === name),
        )
      : desiredOutputs.length === 1
        ? desiredOutputs
        : [];
    if (!targets.length) {
      ambiguityFlags.push({
        field: "transformations",
        reason: "ambiguous operation target",
        question: `Which component needs ${kind}?`,
      });
      continue;
    }
    for (const output of targets) {
      if (
        transformations.some(
          (t) => t.kind === kind && t.inputKeys.includes(output.key),
        )
      )
        continue;
      transformations.push({
        key: transformations.some((t) => t.kind === kind)
          ? `${kind}-${output.key}`
          : kind,
        kind,
        description:
          kind === "engraving" && /\b(?:named|names?)\b/.test(text)
            ? "Engrave individual names"
            : `${kind} using supplied artwork`,
        inputKeys: [output.key],
        outputKeys: [`${result}-${output.key}`],
      });
    }
  }
  const finalRef = (key: string): string => {
    const transformation = transformations.find((t) =>
      t.inputKeys.includes(key),
    );
    return transformation?.outputKeys[0] ?? key;
  };
  if (
    (hasKit && desiredOutputs.some((o) => o.key !== "kit")) ||
    /\bindividual(?:ly)?\s+packag/.test(text)
  ) {
    if (!transformations.some((t) => t.kind === "assembly")) {
      transformations.push({
        key: "assembly",
        kind: "assembly",
        description: /\bindividual(?:ly)?\b/.test(text)
          ? "Package each kit individually"
          : "Assemble the kit",
        inputKeys: desiredOutputs.map((o) => finalRef(o.key)),
        outputKeys: ["packaged-kit"],
      });
    }
    if (/\bindividual(?:ly)?\b/.test(text))
      addRule("assembly.packaging", "individual");
  }
  if (
    (transformations.some((t) => t.kind === "assembly") ||
      /\bdeliver|\bship|\bfulfill?(?:ment)?\b/.test(text)) &&
    !transformations.some((t) => t.kind === "fulfillment")
  ) {
    const assembly = transformations.find((t) => t.kind === "assembly");
    transformations.push({
      key: "fulfillment",
      kind: "fulfillment",
      description: "Deliver the order",
      inputKeys:
        assembly?.outputKeys ?? desiredOutputs.map((o) => finalRef(o.key)),
      outputKeys: ["delivered-kit"],
    });
  }
  for (const [field, missing, question] of [
    ["quantity", quantity === null, "How many units do you need?"],
    ["deadline", deadline === null, "What is the required delivery deadline?"],
    [
      "currency",
      currency === null,
      "Should the order be priced in CAD or USD?",
    ],
    [
      "desiredOutputs",
      desiredOutputs.length === 0,
      "What product should be made?",
    ],
  ] as const) {
    if (missing) ambiguityFlags.push({ field, reason: "missing", question });
  }
  const clauses = text
    .split(sentenceBoundary)
    .flatMap((sentence) => sentence.split(/\s+(?:and|with|including)\s+|,\s+/))
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (const [index, rawClause] of clauses.entries()) {
    if (index === 0) continue;
    const clause = rawClause.trim().replace(/[.!?;]+$/, "");
    if (
      products.some(([, , pattern]) =>
        new RegExp(`\\b${pattern}\\b`).test(clause),
      ) ||
      /^(?:embroider(?:y|ed|ing)?|engrav(?:e|ed|ing)|print(?:ed|ing)?)\s+(?:the\s+)?(?:supplied\s+)?(?:logo|artwork|names?)$/.test(
        clause,
      ) ||
      (/\bengrav(?:e|ed|ing)\b/.test(clauses[index - 1] ?? "") &&
        /^(?:the\s+)?(?:recipient(?:['’]s|s['’]?)?\s+)?names?$/.test(clause)) ||
      /^fulfill?(?:ment)?$/.test(clause) ||
      /^(?:no|without|exclude)\s+(?:leather|polyester)$/.test(clause) ||
      /^(?:actually\s+)?(?:budget|by|under|deliver|ship|individual|individually|named|embroider|embroidery|engrave|engraving|print|printing|logo|artwork|keep|make|qty|quantity|in|usd|cad)\b/.test(
        clause,
      )
    )
      continue;
    ambiguityFlags.push({
      field: "desiredOutputs",
      reason: "unrecognized mock requirement",
      question: `Please specify the component or requirement in "${clause.slice(0, 80)}".`,
    });
  }
  if (/\bpremium\b/.test(text))
    softPreferences.push({
      key: "quality-premium",
      field: "quality",
      operator: "eq",
      value: "premium",
      weight: 0.5,
      unit: null,
      description: "Premium quality preference",
    });
  return {
    outcome: ambiguityFlags.length ? "NEEDS_CLARIFICATION" : "EXTRACTED",
    unsupportedReason: null,
    quantity,
    deadline,
    currency,
    budgetMax: budget,
    desiredOutputs,
    transformations,
    hardConstraints,
    softPreferences,
    ambiguityFlags,
  };
}

export class MockOpenAIAdapter implements OpenAIAdapter {
  async compileIntent(
    input: CompileIntentRequest,
  ): Promise<CompileIntentResult> {
    const parsed = CompileIntentRequestSchema.parse(input);
    return mapExtractionToResult(
      makeExtraction(parsed),
      parsed.previousIntent,
      parsed.assets,
    );
  }

  async extractClaims(
    input: ClaimExtractionRequest,
  ): Promise<ClaimExtractionResult> {
    return mockExtractClaims(input);
  }
}
