import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProductionPlanSchema, type ProductIntent } from "@molecule/contracts";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { describe, expect, it, vi } from "vitest";

import { MockOpenAIAdapter } from "./MockOpenAIAdapter.js";
import { RealOpenAIAdapter } from "./RealOpenAIAdapter.js";
import { mapExtractionToResult } from "./mapExtraction.js";
import { relativeDeadline } from "./relativeDate.js";
import {
  IntentExtractionSchema,
  type IntentExtraction,
} from "./schema/intentExtraction.js";

const base = {
  orderId: "release",
  traceId: "release-compile",
  locale: "en-CA",
  timeZone: "America/Toronto",
  requestedAt: "2026-09-19T12:00:00.000Z",
  assets: [],
};
const acceptance =
  "200 premium black onboarding kits by next Friday under CAD 7,000, no leather, hoodie logo embroidery, named engraved bottles, vegan snacks and individual packaging";
const canonical =
  "200 premium onboarding kits by Friday under CAD 7,000, black, no leather, logo on hoodie, engraved names on bottles, vegan snacks, individually packaged.";
const extraction: IntentExtraction = {
  outcome: "EXTRACTED",
  unsupportedReason: null,
  quantity: 20,
  deadline: "2026-10-01T23:59:59.000Z",
  currency: "CAD",
  budgetMax: 1000,
  desiredOutputs: [
    {
      key: "hoodie",
      name: "Hoodie",
      quantity: 20,
      attributes: [{ name: "product", value: "hoodie" }],
    },
  ],
  transformations: [],
  hardConstraints: [],
  softPreferences: [],
  ambiguityFlags: [],
};
const completed = {
  status: "completed",
  output_parsed: extraction,
  output: [],
};

function pythonSolve(intent: ProductIntent, offline = false, generation = 1) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = execFileSync(
    `${root}/services/solver/.venv/bin/python`,
    [
      "-c",
      `
import json, sys
from test_requirements import kit_payload
from app.cpsat import solve
from app.models import SolverInput
incoming = json.load(sys.stdin)
data = kit_payload()
data["intent"] = incoming["intent"]
data["generation"] = incoming["generation"]
if incoming["offline"]:
    data["candidates"][4]["blockedReasons"] = ["offline"]
print(solve(SolverInput.model_validate(data)).model_dump_json(by_alias=True, exclude_none=True))
`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({ intent, offline, generation }),
      timeout: 20_000,
      env: {
        ...process.env,
        PYTHONPATH: `${root}/services/solver:${root}/services/solver/tests`,
      },
    },
  );
  return ProductionPlanSchema.parse(JSON.parse(result));
}

describe("compiler and solver release acceptance", () => {
  it.each([
    [
      "quantity",
      "Actually make 30 hoodies",
      30,
      1000,
      "CAD",
      extraction.deadline,
    ],
    ["quantity", "Actually make 30", 30, 1000, "CAD", extraction.deadline],
    ["budget", "Actually under USD 1500", 20, 1500, "USD", extraction.deadline],
    [
      "deadline",
      "Actually by 2026-10-08",
      20,
      1000,
      "CAD",
      "2026-10-08T23:59:59.000Z",
    ],
    [
      "deadline",
      "Actually by tomorrow",
      20,
      1000,
      "CAD",
      "2026-09-21T03:59:59.000Z",
    ],
  ] as const)(
    "applies explicit %s corrections over the original customer text: %s",
    async (kind, correction, quantity, budget, currency, deadline) => {
      const adapter = new MockOpenAIAdapter();
      const text = "Make 20 hoodies by 2026-10-01 under CAD 1000";
      const initial = await adapter.compileIntent({ ...base, text });
      if (initial.status !== "READY")
        throw new Error("Expected initial intent");
      const result = await adapter.compileIntent({
        ...base,
        text,
        previousIntent: initial.intent,
        correction: { kind, text: correction },
      });
      expect(result.status).toBe("READY");
      if (result.status !== "READY")
        throw new Error("Expected corrected intent");
      expect(result.intent).toMatchObject({
        quantity,
        budgetMax: budget,
        currency,
        deadline,
        desiredOutputs: [{ outputId: "hoodie", quantity }],
      });
    },
  );

  it("clarifies nonexistent calendar dates instead of rolling into another month", async () => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "Make 20 hoodies by 2026-02-30 CAD",
    });
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    if (result.status !== "NEEDS_CLARIFICATION")
      throw new Error("Expected clarification");
    expect(result.draft.deadline).toBeNull();
    expect(result.draft.ambiguityFlags).toContainEqual(
      expect.objectContaining({ field: "deadline" }),
    );
  });

  it("lets a component attribute correction replace the original equality", async () => {
    const adapter = new MockOpenAIAdapter();
    const text = "Make 20 black hoodies by 2026-10-01 CAD";
    const initial = await adapter.compileIntent({ ...base, text });
    if (initial.status !== "READY") throw new Error("Expected initial intent");
    const result = await adapter.compileIntent({
      ...base,
      text,
      previousIntent: initial.intent,
      correction: { kind: "constraint", text: "Actually white hoodies" },
    });
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("Expected corrected intent");
    expect(result.intent.desiredOutputs[0]?.attributes.color).toBe("white");
    expect(
      result.intent.hardConstraints.filter(
        ({ field }) => field === "hoodie.color",
      ),
    ).toEqual([expect.objectContaining({ operator: "eq", value: "white" })]);
  });

  it("keeps unresolved model flags blocking even if the question is empty", () => {
    const result = mapExtractionToResult(
      {
        ...extraction,
        ambiguityFlags: [
          { field: "material", reason: "conflicted", question: "" },
        ],
      },
      undefined,
      [],
    );
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    if (result.status !== "NEEDS_CLARIFICATION")
      throw new Error("Expected clarification");
    expect(result.questions.length).toBeGreaterThan(0);
  });

  it("maps model constraint scopes to stable component IDs during corrections", () => {
    const initial = mapExtractionToResult(extraction, undefined, []);
    if (initial.status !== "READY") throw new Error("Expected initial intent");
    const rule = {
      key: "red",
      field: "garment.color",
      operator: "eq" as const,
      value: "red",
      unit: null,
      description: null,
    };
    const result = mapExtractionToResult(
      {
        ...extraction,
        desiredOutputs: extraction.desiredOutputs.map((output) => ({
          ...output,
          key: "garment",
        })),
        hardConstraints: [rule],
        softPreferences: [
          {
            ...rule,
            key: "preferred",
            field: "garment.material",
            value: "cotton",
            weight: 0.5,
          },
        ],
      },
      initial.intent,
      [],
    );
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("Expected corrected intent");
    expect(result.intent.desiredOutputs[0]?.outputId).toBe("hoodie");
    expect(result.intent.hardConstraints[0]?.field).toBe("hoodie.color");
    expect(result.intent.softPreferences[0]?.field).toBe("hoodie.material");
  });

  it.each([
    "Make 200 premium black onboarding kits by next Friday (2026-09-25) under CAD 7000. No leather. Each kit needs a black hoodie with embroidered logo, a bottle engraved with the recipient's name, vegan snacks, individual packaging and fulfillment.",
    "200 premium black onboarding kits by next Friday under CAD 7000. No leather. Hoodie logo embroidery, named engraved bottles, vegan snacks, individual packaging and fulfillment.",
    canonical,
  ])("compiles the integrated kit request: %s", async (text) => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text,
    });
    expect(result.status).toBe("READY");
    if (result.status !== "READY")
      throw new Error("Desktop kit compilation failed");
    expect(result.intent.quantity).toBe(200);
    expect(result.intent.budgetMax).toBe(7000);
    expect(result.intent.currency).toBe("CAD");
    expect(
      result.intent.desiredOutputs.map((output) => output.outputId),
    ).toEqual(["hoodie", "bottle", "snacks"]);
    expect(result.intent.transformations).toEqual([
      expect.objectContaining({
        kind: "embroidery",
        inputRefs: ["hoodie"],
        outputRefs: ["embroidered-hoodie"],
      }),
      expect.objectContaining({
        kind: "engraving",
        description: "Engrave individual names",
        inputRefs: ["bottle"],
        outputRefs: ["engraved-bottle"],
      }),
      expect.objectContaining({
        kind: "assembly",
        inputRefs: ["embroidered-hoodie", "engraved-bottle", "snacks"],
        outputRefs: ["packaged-kit"],
      }),
      expect.objectContaining({
        kind: "fulfillment",
        inputRefs: ["packaged-kit"],
        outputRefs: ["delivered-kit"],
      }),
    ]);
    expect(result.intent.hardConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "hoodie.color", value: "black" }),
        expect.objectContaining({ field: "snacks.diet", value: "vegan" }),
        expect.objectContaining({
          field: "assembly.packaging",
          value: "individual",
        }),
        expect.objectContaining({
          field: "material",
          operator: "not_contains",
          value: "leather",
        }),
      ]),
    );
  });

  it.each([".", "!", "?", ";", "\n"])(
    "separates material exclusions and products across %j boundaries",
    async (separator) => {
      const result = await new MockOpenAIAdapter().compileIntent({
        ...base,
        text: [
          "Make 30 by Friday under CAD 2000.50",
          "No leather",
          "Without polyester",
          "Hoodies",
          "",
        ].join(`${separator} `),
      });
      expect(result.status).toBe("READY");
      if (result.status !== "READY") throw new Error("Sentence parsing failed");
      expect(result.intent.budgetMax).toBe(2000.5);
      expect(result.intent.desiredOutputs[0]?.attributes).not.toHaveProperty(
        "material",
      );
      expect(result.intent.hardConstraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "material",
            operator: "not_contains",
            value: "leather",
          }),
          expect.objectContaining({
            field: "material",
            operator: "not_contains",
            value: "polyester",
          }),
        ]),
      );
    },
  );

  it("keeps preference language within its sentence", async () => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "Make 30 hoodies by Friday CAD. Prefer blue bottles. Red shirts.",
    });
    expect(result.status).toBe("READY");
    if (result.status !== "READY")
      throw new Error("Sentence preference parsing failed");
    expect(result.intent.softPreferences).toContainEqual(
      expect.objectContaining({ field: "bottle.color", value: "blue" }),
    );
    expect(result.intent.hardConstraints).toContainEqual(
      expect.objectContaining({ field: "shirt.color", value: "red" }),
    );
  });

  it.each([
    "Fireproof shirts.",
    "Umbrellas.",
    "Refrigerated storage.",
    "No silicone.",
    "Without secret branding.",
    "Hoodies with fireproof coating.",
  ])(
    "still asks about unknown sentence requirements: %s",
    async (requirement) => {
      const result = await new MockOpenAIAdapter().compileIntent({
        ...base,
        text: `Make 30 hoodies by Friday CAD. No leather. ${requirement}`,
      });
      expect(result.status).toBe("NEEDS_CLARIFICATION");
    },
  );

  it.each([
    ["hoodies with embroidered logo", "embroidery"],
    ["shirts with printed artwork", "printing"],
    ["logo on hoodies", "embroidery"],
    ["engraved names on bottles", "engraving"],
    ["bottles engraved with the recipient's name", "engraving"],
    ["bottles engraved with recipients' names", "engraving"],
    ["bottles engraved with the recipient’s name", "engraving"],
    ["hoodies with fulfillment", "fulfillment"],
    ["hoodies with fulfilment", "fulfillment"],
  ])(
    "recognizes %s without accepting arbitrary clause prefixes",
    async (request, operation) => {
      const result = await new MockOpenAIAdapter().compileIntent({
        ...base,
        text: `Make 30 by Friday under CAD 2000, ${request}.`,
      });
      expect(result.status).toBe("READY");
      if (result.status !== "READY")
        throw new Error("Operation clause compilation failed");
      expect(result.intent.transformations).toEqual([
        expect.objectContaining({ kind: operation }),
      ]);
      if (operation === "engraving") {
        expect(result.intent.transformations[0]?.description).toBe(
          "Engrave individual names",
        );
      }
    },
  );

  it.each([
    "hoodies with embroidered fireproof coating",
    "hoodies with embroidered logo and umbrellas",
    "logo on umbrellas",
    "engraved names on carbon plates",
    "matte black",
    "hoodies with printed unknown treatment",
    "bottles engraved with the recipient's fingerprint",
    "hoodies with the recipient's name",
    "hoodies with fulfillment insurance",
    "hoodies with fulfilment and refrigerated storage",
  ])("asks about unknown requirements in %s", async (request) => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: `Make 30 by Friday under CAD 2000, ${request}.`,
    });
    expect(result.status).toBe("NEEDS_CLARIFICATION");
  });

  it.each([
    ["printed logo on shirts", "printing", "shirt"],
    ["shirts with printed logo", "printing", "shirt"],
    ["engraved logo on bottles", "engraving", "bottle"],
    ["bottles with engraved logo", "engraving", "bottle"],
  ])(
    "honors the explicit operation in %s without adding embroidery",
    async (request, kind, component) => {
      const result = await new MockOpenAIAdapter().compileIntent({
        ...base,
        text: `Make 20 by Friday CAD, ${request}.`,
      });
      expect(result.status).toBe("READY");
      if (result.status !== "READY")
        throw new Error("Operation parsing failed");
      expect(result.intent.transformations).toEqual([
        expect.objectContaining({ kind, inputRefs: [component] }),
      ]);
    },
  );

  it("keeps generic logo inference local to the component clause", async () => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "Make 20 by Friday CAD, printed logo on shirts, logo on hoodies, engraved logo on bottles.",
    });
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("Mixed operations failed");
    expect(result.intent.transformations).toHaveLength(3);
    expect(result.intent.transformations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "printing", inputRefs: ["shirt"] }),
        expect.objectContaining({ kind: "embroidery", inputRefs: ["hoodie"] }),
        expect.objectContaining({ kind: "engraving", inputRefs: ["bottle"] }),
      ]),
    );
  });

  it.each([
    "black",
    "white",
    "red",
    "blue",
    "green",
    "cotton",
    "polyester",
    "leather",
    "stainless steel",
    "glass",
    "vegan",
  ])("asks about the unbound standalone attribute %s", async (attribute) => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: `Make 20 hoodies by Friday CAD, ${attribute}.`,
    });
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    if (result.status !== "NEEDS_CLARIFICATION")
      throw new Error("Unbound attribute was silently accepted");
    expect(result.questions.join(" ")).toContain(attribute);
    expect(result.draft.desiredOutputs[0]?.attributes).toEqual({
      product: "hoodie",
    });
  });

  it("asks about an unbound attribute at the start of an additive correction", async () => {
    const adapter = new MockOpenAIAdapter();
    const first = await adapter.compileIntent({
      ...base,
      text: "Make 20 hoodies by Friday CAD",
    });
    if (first.status !== "READY") throw new Error("Initial compilation failed");
    const result = await adapter.compileIntent({
      ...base,
      text: "cotton",
      previousIntent: first.intent,
    });
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    if (result.status !== "NEEDS_CLARIFICATION")
      throw new Error("Correction attribute was silently accepted");
    expect(result.questions.join(" ")).toContain("cotton");
  });

  it.each([
    "Make 20 onboarding kits by Friday CAD, hoodies and shirts, blue.",
    "Make 20 onboarding kits by Friday CAD, shirts and hoodies, blue.",
    "Make 20 onboarding kits by Friday CAD, bottles, blue.",
    "Make 20 onboarding kits by Friday CAD, hoodies, black, blue.",
    "Make 20 blue onboarding kits by Friday CAD, hoodies and shirts.",
  ])(
    "clarifies ambiguous kit color without choosing a component: %s",
    async (text) => {
      const result = await new MockOpenAIAdapter().compileIntent({
        ...base,
        text,
      });
      expect(result.status).toBe("NEEDS_CLARIFICATION");
      if (result.status !== "NEEDS_CLARIFICATION")
        throw new Error("Ambiguous color was silently assigned");
      expect(result.questions.join(" ")).toContain("blue");
      expect(
        result.draft.hardConstraints.some((rule) =>
          rule.field.endsWith(".color"),
        ),
      ).toBe(false);
      for (const output of result.draft.desiredOutputs)
        expect(output.attributes).not.toHaveProperty("color");
    },
  );

  it("binds a detached color to the only wearable in a kit", async () => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "Make 20 onboarding kits by Friday CAD, shirts and bottles, blue.",
    });
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("Kit color binding failed");
    expect(result.intent.hardConstraints).toContainEqual(
      expect.objectContaining({ field: "shirt.color", value: "blue" }),
    );
    expect(
      result.intent.desiredOutputs.find((output) => output.outputId === "shirt")
        ?.attributes.color,
    ).toBe("blue");
    expect(
      result.intent.desiredOutputs.find(
        (output) => output.outputId === "bottle",
      )?.attributes,
    ).not.toHaveProperty("color");
  });

  it("accepts standalone premium only with its recorded quality preference", async () => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "Make 20 hoodies by Friday CAD, premium.",
    });
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("Premium preference failed");
    expect(result.intent.softPreferences).toContainEqual(
      expect.objectContaining({ field: "quality", value: "premium" }),
    );
  });

  it("keeps color component scoped and separates a preference from requirements", async () => {
    const adapter = new MockOpenAIAdapter();
    const result = await adapter.compileIntent({
      ...base,
      text: "Make 30 black hoodies and bottles by Friday CAD",
    });
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("Scoped colors failed");
    expect(result.intent.desiredOutputs[1]?.attributes).not.toHaveProperty(
      "color",
    );
    const preferred = await adapter.compileIntent({
      ...base,
      text: "Make 30 hoodies by Friday CAD, prefer blue hoodies",
    });
    expect(preferred.status).toBe("READY");
    if (preferred.status !== "READY") throw new Error("Preferences failed");
    expect(preferred.intent.hardConstraints).toHaveLength(0);
    expect(preferred.intent.softPreferences).toContainEqual(
      expect.objectContaining({
        field: "hoodie.color",
        value: "blue",
      }),
    );
    const unknown = await adapter.compileIntent({
      ...base,
      text: "Make 30 fireproof hoodies by Friday CAD",
    });
    expect(unknown.status).toBe("NEEDS_CLARIFICATION");
  });
  it("compiles, corrects, certifies and recovers the complete kit through Python", async () => {
    const adapter = new MockOpenAIAdapter();
    const assets = [
      {
        assetId: "logo",
        name: "Logo",
        mimeType: "image/png",
        checksum: "sha256:synthetic",
      },
    ];
    const first = await adapter.compileIntent({
      ...base,
      text: acceptance,
      assets,
    });
    expect(first.status).toBe("READY");
    if (first.status !== "READY") throw new Error("Initial compilation failed");
    expect(first.intent.desiredOutputs.map((o) => o.outputId)).toEqual([
      "hoodie",
      "bottle",
      "snacks",
    ]);
    expect(first.intent.deadline).toBe("2026-09-26T03:59:59.000Z");
    expect(first.intent.budgetMax).toBe(7000);
    expect(first.intent.hardConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "hoodie.color", value: "black" }),
        expect.objectContaining({ field: "snacks.diet", value: "vegan" }),
        expect.objectContaining({
          field: "assembly.packaging",
          value: "individual",
        }),
        expect.objectContaining({ field: "material", value: "leather" }),
      ]),
    );
    const plan = pythonSolve(first.intent);
    expect(plan.status).toBe("VALID");
    expect(plan.nodes).toHaveLength(7);
    expect(plan.edges).toHaveLength(6);
    expect(plan.totalCost).toBe(6380);
    const correction = await adapter.compileIntent({
      ...base,
      text: "No polyester",
      previousIntent: first.intent,
      requestedAt: "2026-09-20T12:00:00.000Z",
    });
    expect(correction.status).toBe("READY");
    if (correction.status !== "READY") throw new Error("Correction failed");
    expect(correction.intent.intentId).toBe(first.intent.intentId);
    expect(correction.intent.version).toBe(2);
    expect(correction.intent.desiredOutputs).toEqual(
      first.intent.desiredOutputs,
    );
    expect(correction.intent.transformations).toEqual(
      first.intent.transformations,
    );
    expect(correction.intent.assets).toEqual(assets);
    expect(correction.intent.hardConstraints).toEqual(
      expect.arrayContaining(first.intent.hardConstraints),
    );
    expect(correction.intent.softPreferences).toEqual(
      first.intent.softPreferences,
    );
    expect(pythonSolve(correction.intent, false, 2).status).toBe("VALID");
    const recovery = pythonSolve(correction.intent, true, 3);
    expect(recovery.status).toBe("VALID");
    expect(recovery.totalCost).toBe(6500);
    expect(recovery.nodes.map((n) => n.merchantId)).toContain("needle-north");
    expect(recovery.nodes.map((n) => n.merchantId)).not.toContain(
      "stitch-works",
    );
  });

  it("certifies the canonical brief and its correction through Python", async () => {
    const adapter = new MockOpenAIAdapter();
    const first = await adapter.compileIntent({ ...base, text: canonical });
    expect(first.status).toBe("READY");
    if (first.status !== "READY")
      throw new Error("Canonical compilation failed");
    expect(first.intent.deadline).toBe("2026-09-26T03:59:59.000Z");
    expect(first.intent.quantity).toBe(200);
    expect(first.intent.budgetMax).toBe(7000);
    expect(first.intent.desiredOutputs.map((o) => o.outputId)).toEqual([
      "hoodie",
      "bottle",
      "snacks",
    ]);
    expect(first.intent.transformations.map((t) => t.kind)).toEqual([
      "embroidery",
      "engraving",
      "assembly",
      "fulfillment",
    ]);
    expect(first.intent.hardConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "hoodie.color", value: "black" }),
        expect.objectContaining({ field: "snacks.diet", value: "vegan" }),
        expect.objectContaining({
          field: "assembly.packaging",
          value: "individual",
        }),
        expect.objectContaining({
          field: "material",
          operator: "not_contains",
          value: "leather",
        }),
      ]),
    );
    expect(first.intent.softPreferences).toContainEqual(
      expect.objectContaining({ field: "quality", value: "premium" }),
    );

    const plan = pythonSolve(first.intent);
    expect(plan.status).toBe("VALID");
    expect(plan.nodes).toHaveLength(7);
    expect(plan.edges).toHaveLength(6);
    expect(plan.totalCost).toBe(6380);

    const correction = await adapter.compileIntent({
      ...base,
      text: "No polyester",
      previousIntent: first.intent,
      requestedAt: "2026-09-20T12:00:00.000Z",
    });
    expect(correction.status).toBe("READY");
    if (correction.status !== "READY")
      throw new Error("Canonical correction failed");
    expect(correction.intent.intentId).toBe(first.intent.intentId);
    expect(correction.intent.version).toBe(2);
    expect(correction.intent.desiredOutputs).toEqual(
      first.intent.desiredOutputs,
    );
    expect(correction.intent.transformations).toEqual(
      first.intent.transformations,
    );
    expect(correction.intent.hardConstraints).toEqual(
      expect.arrayContaining([
        ...first.intent.hardConstraints,
        expect.objectContaining({
          field: "material",
          operator: "not_contains",
          value: "polyester",
        }),
      ]),
    );
    const corrected = pythonSolve(correction.intent, false, 2);
    expect(corrected.status).toBe("VALID");
    expect(corrected.nodes).toHaveLength(7);
    expect(corrected.totalCost).toBe(6380);
  });

  it("supports varied components and component quantities", async () => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "Make 30 red shirts and 60 notebooks by Friday under CAD 2000",
    });
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("Varied products failed");
    expect(
      result.intent.desiredOutputs.map((o) => [o.outputId, o.quantity]),
    ).toEqual([
      ["shirt", 30],
      ["notebook", 60],
    ]);
  });

  it("targets an operation on its named component and covers repeated operations", async () => {
    const adapter = new MockOpenAIAdapter();
    const result = await adapter.compileIntent({
      ...base,
      text: "Make 20 embroidered shirts and 20 embroidered hoodies by Friday CAD",
    });
    expect(result.status).toBe("READY");
    if (result.status !== "READY")
      throw new Error("Repeated operations failed");
    expect(
      result.intent.transformations.map((t) => t.inputRefs[0]).sort(),
    ).toEqual(["hoodie", "shirt"]);
    expect(
      new Set(result.intent.transformations.map((t) => t.transformationId))
        .size,
    ).toBe(2);
  });

  it("asks about an unsupported component instead of silently dropping it", async () => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "Make 30 hoodies and 60 umbrellas by Friday CAD",
    });
    expect(result.status).toBe("NEEDS_CLARIFICATION");
  });

  it.each([
    [
      "next Friday",
      "2026-09-25T12:00:00Z",
      "America/Toronto",
      "2026-10-03T03:59:59.000Z",
    ],
    [
      "this Friday",
      "2026-09-25T12:00:00Z",
      "America/Toronto",
      "2026-09-26T03:59:59.000Z",
    ],
    [
      "next Sunday",
      "2026-10-30T12:00:00Z",
      "America/New_York",
      "2026-11-02T04:59:59.000Z",
    ],
    [
      "tomorrow",
      "2026-09-19T01:00:00Z",
      "America/Los_Angeles",
      "2026-09-20T06:59:59.000Z",
    ],
    [
      "Friday",
      "2026-09-19T12:00:00Z",
      "Asia/Kolkata",
      "2026-09-25T18:29:59.000Z",
    ],
  ])(
    "resolves %s from the caller's local calendar",
    (text, at, zone, expected) => {
      expect(relativeDeadline(text, at, zone)).toBe(expected);
    },
  );

  it("never makes cyclic or dangling extracted graphs READY", () => {
    for (const inputKeys of [["absent"], ["finished"]]) {
      const result = mapExtractionToResult(
        {
          ...extraction,
          transformations: [
            {
              key: "embroidery",
              kind: "embroidery",
              description: "Logo",
              inputKeys,
              outputKeys: ["finished"],
            },
          ],
        },
        undefined,
        [],
      );
      expect(result.status).toBe("NEEDS_CLARIFICATION");
    }
  });
});

describe("strict Responses boundary", () => {
  it("uses the strict Responses text schema with required nullable fields", () => {
    const format = zodTextFormat(IntentExtractionSchema, "product_intent");
    expect(format.type).toBe("json_schema");
    expect(format.strict).toBe(true);
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.type === "object") {
          expect(record.additionalProperties).toBe(false);
          expect(record.required).toEqual(
            Object.keys(record.properties as object),
          );
        }
        Object.values(record).forEach(visit);
      }
    };
    visit(format.schema);
  });

  it("repairs SDK JSON parsing failures once, carrying multimodal context and bounded configuration", async () => {
    const parse = vi
      .fn()
      .mockRejectedValueOnce(new SyntaxError("malformed"))
      .mockResolvedValueOnce(completed);
    const adapter = new RealOpenAIAdapter({
      apiKey: "server-test-only",
      timeoutMs: 1234,
      compilerModel: "configured-model",
      client: { responses: { parse } } as unknown as OpenAI,
    });
    const result = await adapter.compileIntent({
      ...base,
      text: "Make 20 hoodies by Friday CAD",
      assets: [
        {
          assetId: "logo",
          mimeType: "image/png",
          url: "https://example.test/logo.png",
        },
        {
          assetId: "brief",
          mimeType: "application/pdf",
          checksum: "test",
          providerFileId: "file-brief",
        },
      ],
    });
    expect(result.status).toBe("READY");
    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse.mock.calls[0]?.[0]).toMatchObject({
      model: "configured-model",
      max_output_tokens: 6000,
      store: false,
      metadata: { trace_id: base.traceId },
    });
    expect(parse.mock.calls[0]?.[1]).toMatchObject({ timeout: 1234 });
    const content = parse.mock.calls[0]?.[0].input[0].content;
    expect(content).toEqual(
      expect.arrayContaining([
        {
          type: "input_image",
          image_url: "https://example.test/logo.png",
          detail: "auto",
        },
        { type: "input_file", file_id: "file-brief" },
      ]),
    );
    expect(JSON.stringify(content)).toContain(base.requestedAt);
    expect(JSON.stringify(parse.mock.calls[1])).toContain(
      "Malformed JSON output",
    );
    expect(JSON.stringify(parse.mock.calls)).not.toContain("server-test-only");
  });

  it("repairs a semantically invalid graph once then fails visibly", async () => {
    const parse = vi.fn().mockResolvedValue({
      ...completed,
      output_parsed: {
        ...extraction,
        transformations: [
          {
            key: "embroidery",
            kind: "embroidery",
            description: "Logo",
            inputKeys: ["hoodie"],
            outputKeys: ["hoodie"],
          },
        ],
      },
    });
    const adapter = new RealOpenAIAdapter({
      apiKey: "test",
      client: { responses: { parse } } as unknown as OpenAI,
    });
    await expect(
      adapter.compileIntent({ ...base, text: acceptance }),
    ).rejects.toMatchObject({ code: "VALIDATION", retryable: false });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it.each(["failed", "incomplete", "queued", "in_progress"])(
    "rejects %s responses without certifying",
    async (status) => {
      const parse = vi.fn().mockResolvedValue({ ...completed, status });
      const adapter = new RealOpenAIAdapter({
        apiKey: "test",
        client: { responses: { parse } } as unknown as OpenAI,
      });
      await expect(
        adapter.compileIntent({ ...base, text: acceptance }),
      ).rejects.toBeInstanceOf(Error);
      expect(parse).toHaveBeenCalledTimes(1);
    },
  );
});
