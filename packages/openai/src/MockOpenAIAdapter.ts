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
  ["phone case", "Phone case", "phone cases?"],
  ["laptop sleeve", "Laptop sleeve", "laptop sleeves?"],
  ["desk mat", "Desk mat", "desk mats?"],
  ["keycap", "Keycap", "keycaps?"],
  ["picture frame", "Picture frame", "picture frames?"],
  ["cutting board", "Cutting board", "cutting boards?"],
  ["gym towel", "Gym towel", "gym towels?"],
  ["pet tag", "Pet tag", "pet tags?"],
  ["luggage tag", "Luggage tag", "luggage tags?"],
  ["gift tin", "Gift tin", "gift tins?"],
  ["organizer", "Organizer", "organizers?"],
  ["enclosure", "Enclosure", "enclosures?"],
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
const colors = ["black", "white", "red", "blue", "green"] as const;
const materials = [
  "polycarbonate",
  "acrylic",
  "bamboo",
  "nylon",
  "wood",
  "aluminum",
  "ceramic",
  "pla",
  "petg",
  "abs",
  "resin",
  "tpu",
  "cork",
  "cotton",
  "polyester",
  "leather",
  "stainless steel",
  "glass",
] as const;
const wearables = ["hoodie", "shirt", "jacket", "hat"];
const operations = [
  [/\buv[ _-]print\w*\b/, "uv_printing", "uv-printed"],
  [/\bscreen[ _-]print\w*\b/, "screen_printing", "screen-printed"],
  [/\bdigital[ _-]print\w*\b/, "digital_printing", "digital-printed"],
  [/\bpad[ _-]print\w*\b/, "pad_printing", "pad-printed"],
  [/\b3d[ _-]print\w*\b/, "3d_printing", "3d-printed"],
  [/\bheat[ _-]transfer\w*\b/, "heat_transfer", "heat-transferred"],
  [/\b(?:dye[ _-])?sublimat\w*\b/, "sublimation", "sublimated"],
  [/\bembroider\w*\b/, "embroidery", "embroidered"],
  [/\bengrav\w*\b/, "engraving", "engraved"],
  [/\bprint\w*\b/, "printing", "printed"],
] as const;

function clausesOf(text: string, separators: RegExp): string[] {
  return text
    .split(sentenceBoundary)
    .flatMap((sentence) => sentence.split(separators))
    .map((clause) => clause.trim().replace(/[.!?;]+$/, ""))
    .filter(Boolean);
}

function mentioned(clause: string): string[] {
  return products
    .filter(([, , pattern]) => new RegExp(`\\b${pattern}\\b`).test(clause))
    .map(([product]) => product);
}

function numericMatch(text: string, pattern: RegExp): number | null {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? null : Number(value.replaceAll(",", ""));
}

function quantityIn(text: string): number | null {
  return (
    numericMatch(text, /(\d[\d,]*)\s+(?:[\w-]+\s+){0,4}kits?\b/) ??
    numericMatch(
      text,
      /(?:quantity|qty|make|need|want)\s*(?:of\s*)?(\d[\d,]*)/,
    ) ??
    numericMatch(
      text,
      new RegExp(
        `(\\d[\\d,]*)\\s+(?:[\\w-]+\\s+){0,3}(?:${products.map((p) => p[2]).join("|")})\\b`,
      ),
    )
  );
}

function makeExtraction(input: CompileIntentRequest): IntentExtraction {
  const previous = input.previousIntent;
  const text = `${input.text}\n${input.correction?.text ?? ""}`.toLowerCase();
  const sources = [input.correction?.text ?? "", input.text].map((source) =>
    source.toLowerCase(),
  );
  const clauses = clausesOf(text, /\s+(?:and|with|including)\s+|,\s+/);
  const segments = clausesOf(text, /,|\band\b/);
  const consumedClauses = new Set<number>();
  const ambiguityFlags: IntentExtraction["ambiguityFlags"] = [];
  const softPreferences: IntentExtraction["softPreferences"] = [];
  const quantitySource = sources.find((source) => quantityIn(source) !== null);
  const quantity =
    (quantitySource === undefined ? null : quantityIn(quantitySource)) ??
    previous?.quantity ??
    null;
  const budget =
    sources
      .map((source) =>
        numericMatch(
          source,
          /\b(?:budget(?:\s+(?:of|is))?|max(?:imum)?|under)\s*(?:cad|usd)?\s*\$?(\d[\d,]*(?:\.\d+)?)/,
        ),
      )
      .find((value) => value !== null) ??
    previous?.budgetMax ??
    null;
  let deadline = previous?.deadline ?? null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
    for (const source of sources) {
      const iso =
        /20\d\d-\d\d-\d\d(?:t\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:z|[+-]\d\d:\d\d))?/i.exec(
          source,
        )?.[0];
      if (iso) {
        const calendarDate = iso.slice(0, 10);
        if (
          new Date(`${calendarDate}T00:00:00.000Z`)
            .toISOString()
            .slice(0, 10) !== calendarDate
        )
          throw new RangeError("Invalid calendar date");
        deadline = new Date(
          iso.includes("t") ? iso : `${iso}T23:59:59.000Z`,
        ).toISOString();
        break;
      }
      const relative = relativeDeadline(
        source,
        input.requestedAt,
        input.timeZone,
      );
      if (relative !== null) {
        deadline = relative;
        break;
      }
    }
  } catch {
    ambiguityFlags.push({
      field: "deadline",
      reason: "invalid date or time zone",
      question: "What is the delivery date and IANA time zone?",
    });
  }
  const currencySource =
    sources.find((source) => /\b(?:usd|cad)\b/.test(source)) ?? "";
  const currency = /\busd\b/.test(currencySource)
    ? "USD"
    : /\bcad\b/.test(currencySource)
      ? "CAD"
      : (previous?.currency ?? null);
  if (/\busd\b/.test(currencySource) && /\bcad\b/.test(currencySource)) {
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
      !materials.some((material) => material === prefix) &&
      !/^(?:\d[\d,]*|a|an|the|some|make|need|want|of|with|on|onto|for|to|per|include|including|black|white|red|blue|green|cotton|polyester|leather|steel|glass|vegan|premium|embroidered|engraved|printed|named)$/.test(
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
    if (product === "phone case") {
      const model =
        /\b(?:iphone|pixel|galaxy)\s+\d+(?:\s+(?:pro|max|plus|mini)){0,2}\b/.exec(
          text,
        )?.[0];
      if (model)
        output.attributes = [
          ...output.attributes.filter(
            (attribute) => attribute.name !== "deviceModel",
          ),
          { name: "deviceModel", value: model },
        ];
      else
        ambiguityFlags.push({
          field: "phone case.deviceModel",
          reason: "Device model is required",
          question: "Which phone model must the case fit?",
        });
    }
    if (product === "enclosure") {
      const dimensions = /(\d+)\s*[x×]\s*(\d+)\s*[x×]\s*(\d+)\s*mm\b/.exec(
        text,
      );
      if (dimensions)
        for (const [index, name] of [
          "widthMm",
          "depthMm",
          "heightMm",
        ].entries())
          output.attributes.push({
            name,
            value: Number(dimensions[index + 1]),
          });
    }
    const componentQuantity = numericMatch(
      quantitySource ?? text,
      new RegExp(
        `(\\d[\\d,]*)\\s+(?:black\\s+|vegan\\s+|cotton\\s+)?${pattern}\\b`,
      ),
    );
    if (componentQuantity !== null) output.quantity = componentQuantity;
    for (const [field, values] of [
      ["color", colors],
      ["material", materials],
      ["diet", ["vegan"]],
    ] as const) {
      const match = sources.flatMap((source) =>
        values
          .filter((value) =>
            new RegExp(
              `\\b${value}\\s+(?:(?:cotton|polyester|leather|stainless steel|glass|black|white|red|blue|green|vegan|premium|embroidered|engraved|printed)\\s+){0,3}${pattern}\\b`,
            ).test(source),
          )
          .map((value) => ({ value, source })),
      )[0];
      const value = match?.value;
      if (value && !new RegExp(`\\b(?:no|without)\\s+${value}\\b`).test(text)) {
        const clause = match.source
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
  const kitColors = hasKit
    ? colors.filter(
        (value) =>
          new RegExp(`\\b${value}\\b(?:\\s+[\\w-]+){0,3}\\s+kits?\\b`).test(
            text,
          ) || clauses.includes(value),
      )
    : [];
  const wearableOutputs = desiredOutputs.filter((output) =>
    wearables.includes(output.key),
  );
  const kitColor = kitColors[0];
  const wearable = wearableOutputs[0];
  if (
    kitColor &&
    wearable &&
    kitColors.length === 1 &&
    wearableOutputs.length === 1 &&
    !new RegExp(`\\b(?:no|without)\\s+${kitColor}\\b`).test(text)
  ) {
    addRule(`${wearable.key}.color`, kitColor);
    wearable.attributes = [
      ...wearable.attributes.filter((a) => a.name !== "color"),
      { name: "color", value: kitColor },
    ];
    for (const [index, clause] of clauses.entries())
      if (clause === kitColor) consumedClauses.add(index);
  } else if (kitColors.length) {
    ambiguityFlags.push({
      field: "color",
      reason: "unresolved kit color",
      question: `Which component should use each requested color (${kitColors.join(", ")})?`,
    });
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
  for (const [trigger, kind, result] of operations) {
    if (
      kind === "printing" &&
      /\b(?:uv|screen|digital|pad|3d)[ _-]print/.test(text)
    )
      continue;
    const operationSegments = segments.filter(
      (segment) =>
        trigger.test(segment) ||
        (kind === "embroidery" &&
          /\blogo\b/.test(segment) &&
          !operations.some(([explicit]) => explicit.test(segment))),
    );
    if (!operationSegments.length) continue;
    const matched = operationSegments.flatMap((segment) => {
      const components = mentioned(segment);
      return components.length === 1 ? components : [];
    });
    const targets = matched.length
      ? desiredOutputs.filter((output) => matched.includes(output.key))
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
        inputKeys: [
          transformations
            .filter(
              (t) =>
                t.key === output.key ||
                t.outputKeys.some((ref) => ref.endsWith(`-${output.key}`)),
            )
            .at(-1)?.outputKeys[0] ?? output.key,
        ],
        outputKeys: [`${result}-${output.key}`],
      });
    }
  }
  const finalRef = (key: string): string => {
    const seen = new Set<string>();
    while (!seen.has(key)) {
      seen.add(key);
      const transformation = transformations.find(
        (t) => t.inputKeys.length === 1 && t.inputKeys.includes(key),
      );
      if (!transformation?.outputKeys[0]) break;
      key = transformation.outputKeys[0];
    }
    return key;
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
  if (/\bpremium\b/.test(text)) {
    softPreferences.push({
      key: "quality-premium",
      field: "quality",
      operator: "eq",
      value: "premium",
      weight: 0.5,
      unit: null,
      description: "Premium quality preference",
    });
    for (const [index, clause] of clauses.entries())
      if (clause === "premium") consumedClauses.add(index);
  }
  for (const [index, clause] of clauses.entries()) {
    if (consumedClauses.has(index)) continue;
    if (
      [...colors, ...materials, "vegan", "premium"].some(
        (value) => value === clause,
      )
    ) {
      ambiguityFlags.push({
        field: "desiredOutputs",
        reason: "unbound mock attribute",
        question: `Which component should have the "${clause}" requirement?`,
      });
      continue;
    }
    if (index === 0) continue;
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
