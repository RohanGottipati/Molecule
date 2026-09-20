import {
  INITIAL_CATALOG_CATEGORIES,
  ProductIntentSchema,
  validateCatalogJsonl,
  type CatalogRecord,
  type ProductIntent,
} from "@molecule/contracts";

export const BROAD_CATALOG_CLOCK = "2026-09-19T12:00:00.000Z";
const evidence = {
  sourceReference: "fixture:broad-network-v1",
  observedAt: BROAD_CATALOG_CLOCK,
  synthetic: true,
};
// These are test fixtures, not operational claims about connected Shopify stores.
export const BROAD_CATALOG_MERCHANTS = [
  ["base-goods", "BaseGoods"],
  ["stitch-works", "StitchWorks"],
  ["thread-forge", "ThreadForge"],
  ["laser-lab", "LaserLab"],
  ["print-press", "PrintPress"],
  ["snack-box", "SnackBox"],
  ["pack-ship", "PackShip"],
  ["needle-north", "Needle North"],
  ["tech-works", "TechWorks"],
  ["home-works", "HomeWorks"],
  ["maker-works", "MakerWorks"],
  ["surface-works", "SurfaceWorks"],
  ["route-ship", "RouteShip"],
  ["molecule-storefront", "Molecule Storefront"],
] as const;

// Each row changes the product, substrate, or transformation; no color/size padding.
const products: [string, string, string][][] = [
  [
    ["hoodie", "cotton", "embroidery"],
    ["tshirt", "cotton", "screen_printing"],
    ["cap", "twill", "embroidery"],
    ["apron", "canvas", "embroidery"],
    ["jacket", "nylon", "heat_transfer"],
    ["beanie", "wool", "embroidery"],
    ["polo", "pique cotton", "embroidery"],
    ["socks", "cotton blend", "heat_transfer"],
  ],
  [
    ["tote", "canvas", "screen_printing"],
    ["backpack", "nylon", "embroidery"],
    ["pouch", "cotton", "embroidery"],
    ["wallet", "cork", "engraving"],
    ["belt", "vegan leather", "engraving"],
    ["keyring", "aluminum", "engraving"],
    ["duffel", "polyester", "heat_transfer"],
    ["messenger bag", "canvas", "embroidery"],
  ],
  [
    ["phone case", "polycarbonate", "uv_printing"],
    ["laptop sleeve", "neoprene", "heat_transfer"],
    ["tablet cover", "polyurethane", "uv_printing"],
    ["cable clip", "silicone", "pad_printing"],
    ["charger shell", "abs", "uv_printing"],
    ["mouse shell", "abs", "uv_printing"],
    ["webcam cover", "abs", "pad_printing"],
    ["powerbank shell", "aluminum", "engraving"],
  ],
  [
    ["welcome insert", "paper", "digital_printing"],
    ["notebook", "kraft paper", "screen_printing"],
    ["desk mat", "rubber", "sublimation"],
    ["pen", "aluminum", "engraving"],
    ["nameplate", "acrylic", "uv_printing"],
    ["clipboard", "bamboo", "engraving"],
    ["document folder", "cardstock", "digital_printing"],
    ["bookend", "wood", "engraving"],
  ],
  [
    ["keycap", "pbt", "dye_sublimation"],
    ["controller shell", "abs", "uv_printing"],
    ["gaming mat", "polyester", "sublimation"],
    ["headset stand", "aluminum", "engraving"],
    ["dice tray", "wood", "engraving"],
    ["token", "acrylic", "uv_printing"],
    ["card deck box", "bamboo", "engraving"],
    ["console skin", "vinyl", "digital_printing"],
  ],
  [
    ["picture frame", "wood", "engraving"],
    ["wall tile", "ceramic", "sublimation"],
    ["cushion cover", "cotton", "screen_printing"],
    ["vase", "glass", "engraving"],
    ["door sign", "acrylic", "uv_printing"],
    ["candle vessel", "glass", "uv_printing"],
    ["clock face", "bamboo", "engraving"],
    ["planter", "ceramic", "uv_printing"],
  ],
  [
    ["mug", "coated ceramic", "sublimation"],
    ["cutting board", "bamboo", "engraving"],
    ["coaster", "cork", "engraving"],
    ["tea towel", "linen", "embroidery"],
    ["lunch box", "stainless steel", "engraving"],
    ["placemat", "polyester", "sublimation"],
    ["spice jar", "glass", "uv_printing"],
    ["serving tray", "wood", "engraving"],
  ],
  [
    ["steel bottle", "stainless steel", "engraving"],
    ["gym towel", "cotton", "embroidery"],
    ["yoga block", "cork", "engraving"],
    ["resistance band pouch", "polyester", "heat_transfer"],
    ["shaker", "polypropylene", "pad_printing"],
    ["medal", "aluminum", "engraving"],
    ["sweatband", "cotton", "embroidery"],
    ["foam roller sleeve", "polyester", "sublimation"],
  ],
  [
    ["pet tag", "aluminum", "engraving"],
    ["pet bandana", "cotton", "screen_printing"],
    ["pet bowl", "stainless steel", "engraving"],
    ["leash", "nylon", "heat_transfer"],
    ["collar", "polyester", "sublimation"],
    ["pet blanket", "fleece", "embroidery"],
    ["treat jar", "glass", "uv_printing"],
    ["pet placemat", "silicone", "pad_printing"],
  ],
  [
    ["luggage tag", "aluminum", "engraving"],
    ["passport cover", "cork", "engraving"],
    ["packing cube", "nylon", "heat_transfer"],
    ["sleep mask", "cotton", "embroidery"],
    ["travel tumbler", "stainless steel", "engraving"],
    ["toiletry bag", "canvas", "embroidery"],
    ["travel journal", "paper", "digital_printing"],
    ["compass case", "brass", "engraving"],
  ],
  [
    ["snack gift box", "cardstock", "digital_printing"],
    ["gift tin", "steel", "uv_printing"],
    ["ornament", "wood", "engraving"],
    ["gift card", "paper", "digital_printing"],
    ["photo panel", "coated aluminum", "sublimation"],
    ["keepsake box", "bamboo", "engraving"],
    ["bookmark", "brass", "engraving"],
    ["award plaque", "acrylic", "uv_printing"],
  ],
  [
    ["organizer", "pla", "3d_printing"],
    ["device mount", "petg", "3d_printing"],
    ["enclosure", "abs", "3d_printing"],
    ["miniature", "resin", "3d_printing"],
    ["grommet", "tpu", "3d_printing"],
    ["jig", "nylon", "3d_printing"],
    ["bracket", "carbon petg", "3d_printing"],
    ["knob", "asa", "3d_printing"],
  ],
];
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export function broadCatalogFixture(
  version = "broad-fixture-v1",
  recipeLimit = 100,
): {
  jsonl: string;
  recipes: Extract<CatalogRecord, { recordType: "recipe" }>[];
} {
  const records: Record<string, unknown>[] = [];
  const recipes: Extract<CatalogRecord, { recordType: "recipe" }>[] = [];
  const resourceIds = new Set<string>();
  for (const [id, name] of BROAD_CATALOG_MERCHANTS)
    records.push({ recordType: "merchant", id, name, evidence });
  const specs = new Map<
    string,
    {
      category: string;
      material: string;
      operation: string;
      supply: string;
      transform: string;
    }
  >();
  function offer(
    product: string,
    category: string,
    material: string,
    operation: string,
    merchantId: string,
    kind: string,
    accepts?: unknown[],
    produces?: unknown[],
  ) {
    const id = `${merchantId}:${slug(product)}:${operation}`;
    const resourceId =
      kind === "SUPPLY"
        ? `stock:${merchantId}:${slug(product)}`
        : `machine:${merchantId}:${operation}`;
    if (!resourceIds.has(resourceId)) {
      records.push({
        recordType: "resource",
        id: resourceId,
        merchantId,
        kind: kind === "SUPPLY" ? "inventory" : "processing",
        unit: "units",
        availability: {
          status: "known",
          value: kind === "SUPPLY" ? 100000 : 10000,
        },
        ...(kind === "SUPPLY" ? {} : { periodMinutes: 1440 }),
        evidence,
      });
      resourceIds.add(resourceId);
    }
    const attributes = {
      product,
      ...(product === "phone case" ? { deviceModel: "iPhone 16" } : {}),
      ...(product === "enclosure"
        ? { widthMm: 100, depthMm: 80, heightMm: 40 }
        : {}),
    };
    const port = {
      kind: "product",
      name: "$item",
      unit: "units",
      attributes: { product: "$item" },
    };
    const requiredAssetIds =
      kind === "TRANSFORM"
        ? [operation === "3d_printing" ? "model" : "artwork"]
        : [];
    records.push(
      {
        recordType: "product",
        id: `product:${id}`,
        merchantId,
        name: `${product} ${operation}`,
        category,
        itemKind: kind === "SUPPLY" ? "physical" : "service",
        evidence,
      },
      {
        recordType: "variant",
        id: `variant:${id}`,
        merchantId,
        productId: `product:${id}`,
        sku: id.toUpperCase(),
        material: { status: "known", value: material },
        attributes,
        supportedOperations: [operation],
        unit: "units",
        evidence,
      },
      {
        recordType: "family",
        id: `family:${id}`,
        kind,
        operation,
        accepts: accepts ?? (kind === "SUPPLY" ? [] : [port]),
        produces: produces ?? [port],
        requiredAssetIds,
        evidence,
      },
      {
        recordType: "binding",
        id,
        merchantId,
        familyId: `family:${id}`,
        variantId: `variant:${id}`,
        factIds: Object.fromEntries(
          ["pricing", "quantity", "timing", "coverage"].map((field) => [
            field,
            `${id}:${field}`,
          ]),
        ),
        resources: [{ resourceId, unitsPerItem: 1 }],
        evidence,
      },
    );
    const values = {
      pricing: {
        currency: "CAD",
        basis: "per_item",
        unitPrice: kind === "SUPPLY" ? 4 : 1,
        setupFee: kind === "TRANSFORM" ? 5 : 0,
        minimumTotal: 0,
      },
      quantity: { min: 1, max: 10000, unit: "units" },
      timing: { leadMinutes: 15, transferMinutes: 30 },
      coverage: { countries: ["CA"] },
    };
    for (const [field, value] of Object.entries(values))
      records.push({
        recordType: "fact",
        id: `${id}:${field}`,
        merchantId,
        subjectId: id,
        field,
        assertion: { status: "known", value },
        evidence,
      });
  }
  let sequence = 0;
  function recipe(
    id: string,
    category: string,
    components: string[],
    bundle: boolean,
  ) {
    const desiredOutputs: ProductIntent["desiredOutputs"] = components.map(
      (name) => ({
        outputId: slug(name),
        name,
        quantity: 10,
        attributes: {
          product: name,
          material: specs.get(name)!.material,
          ...(name === "phone case" ? { deviceModel: "iPhone 16" } : {}),
        },
      }),
    );
    const transformations: ProductIntent["transformations"] = components.map(
      (name) => ({
        transformationId: `${slug(name)}:customize`,
        kind: specs.get(name)!.operation,
        description: `Customize ${name} using the supplied ${specs.get(name)!.operation === "3d_printing" ? "3D model" : "artwork"}`,
        inputRefs: [slug(name)],
        outputRefs: [`custom:${slug(name)}`],
      }),
    );
    if (bundle) {
      const inputPorts = components.map((name) => ({
        kind: "product",
        name,
        unit: "units",
        attributes: { product: name, material: specs.get(name)!.material },
      }));
      const outputPort = {
        kind: "product",
        name: id,
        unit: "units",
        attributes: { product: id, material: "mixed" },
      };
      offer(
        id,
        category,
        "mixed",
        "assembly",
        "pack-ship",
        "ASSEMBLE",
        inputPorts,
        [outputPort],
      );
      offer(
        id,
        category,
        "mixed",
        "fulfillment",
        "pack-ship",
        "FULFILL",
        [outputPort],
        [outputPort],
      );
      transformations.push(
        {
          transformationId: "assembly",
          kind: "assembly",
          description: "Assemble one of each component per bundle",
          inputRefs: components.map((name) => `custom:${slug(name)}`),
          outputRefs: ["assembled"],
        },
        {
          transformationId: "fulfillment",
          kind: "fulfillment",
          description: "Deliver bundles within Canada",
          inputRefs: ["assembled"],
          outputRefs: ["delivered"],
        },
      );
    } else
      transformations.push({
        transformationId: "fulfillment",
        kind: "fulfillment",
        description: "Deliver individual products within Canada",
        inputRefs: [`custom:${slug(components[0]!)}`],
        outputRefs: ["delivered"],
      });
    const intent = ProductIntentSchema.parse({
      intentId: `d5716621-0562-4000-8000-${String(++sequence).padStart(12, "0")}`,
      version: 1,
      quantity: 10,
      deadline: "2026-10-19T12:00:00.000Z",
      currency: "CAD",
      budgetMax: 2000,
      desiredOutputs,
      transformations,
      hardConstraints: [],
      softPreferences: [],
      assets: [
        { assetId: "artwork", checksum: "synthetic-artwork-v1" },
        { assetId: "model", checksum: "synthetic-model-v1" },
      ],
      ambiguityFlags: [],
    });
    const value = {
      recordType: "recipe" as const,
      id: `recipe:${id}`,
      category,
      prompt: `Create 10 ${bundle ? id + " bundles containing " : "customized "}${components.join(", ")} in the specified materials. Use the supplied artwork/model; deliver to Canada by October 19, 2026 for at most CAD 2000.`,
      intent,
      expected: {
        outputKind: bundle ? ("bundle" as const) : ("individual" as const),
        operations: [...new Set(transformations.map((t) => t.kind))],
        minimumDistinctSuppliers: id === "onboarding" ? 7 : 2,
      },
      evidence,
    };
    recipes.push(value);
    records.push(value);
  }
  for (const [index, group] of products.entries()) {
    const category = INITIAL_CATALOG_CATEGORIES[index]!;
    for (const [name, material, operation] of group) {
      const supply =
        name === "welcome insert"
          ? "print-press"
          : name === "snack gift box"
            ? "snack-box"
            : name === "steel bottle"
              ? "base-goods"
              : index < 2 || index === 7 || index === 8 || index === 9
                ? "base-goods"
                : index === 2 || index === 4
                  ? "tech-works"
                  : index === 11
                    ? "maker-works"
                    : "home-works";
      const transform =
        operation === "embroidery"
          ? "stitch-works"
          : operation === "engraving"
            ? "laser-lab"
            : operation === "3d_printing"
              ? "maker-works"
              : name === "welcome insert"
                ? "print-press"
                : operation === "digital_printing"
                  ? "print-press"
                  : "surface-works";
      specs.set(name, { category, material, operation, supply, transform });
      offer(name, category, material, "supply", supply, "SUPPLY");
      offer(name, category, material, operation, transform, "TRANSFORM");
      // Independently evidenced fallbacks for textile, print and fulfilment recovery.
      if (operation === "embroidery")
        offer(name, category, material, operation, "needle-north", "TRANSFORM");
      if (operation === "digital_printing")
        offer(
          name,
          category,
          material,
          operation,
          "surface-works",
          "TRANSFORM",
        );
      offer(name, category, material, "fulfillment", "pack-ship", "FULFILL");
      offer(name, category, material, "fulfillment", "route-ship", "FULFILL");
      recipe(slug(name), category, [name], false);
    }
  }
  recipe(
    "onboarding",
    "Gifts",
    ["hoodie", "steel bottle", "welcome insert", "organizer", "snack gift box"],
    true,
  );
  recipe(
    "creator-desk",
    "Desk & Office",
    ["desk mat", "organizer", "steel bottle"],
    true,
  );
  recipe(
    "conference",
    "Bags & Accessories",
    ["tote", "welcome insert", "pen"],
    true,
  );
  recipe(
    "outdoor-gift",
    "Travel",
    ["cap", "steel bottle", "snack gift box"],
    true,
  );
  const selectedRecipes =
    recipeLimit === 20
      ? recipes.filter(
          (_, index) =>
            index < 96 && (index % 8 === 0 || (index < 64 && index % 8 === 1)),
        )
      : recipes.slice(0, recipeLimit);
  const selectedIds = new Set(selectedRecipes.map((r) => r.id));
  const selectedRecords = records.filter(
    (r) => r.recordType !== "recipe" || selectedIds.has(String(r.id)),
  );
  const recordCounts = Object.fromEntries(
    [
      "merchant",
      "product",
      "variant",
      "family",
      "resource",
      "fact",
      "binding",
      "recipe",
    ].map((kind) => [
      kind,
      selectedRecords.filter((r) => r.recordType === kind).length,
    ]),
  );
  const manifest = {
    recordType: "manifest",
    schemaVersion: 1,
    catalogVersion: version,
    createdAt: BROAD_CATALOG_CLOCK,
    categories: INITIAL_CATALOG_CATEGORIES,
    complete: true,
    recordCounts,
  };
  const jsonl = [manifest, ...selectedRecords]
    .map((record) => JSON.stringify(record))
    .join("\n");
  const report = validateCatalogJsonl(jsonl);
  if (report.errors.length) throw new Error(report.errors.join("\n"));
  return { jsonl, recipes: selectedRecipes };
}
