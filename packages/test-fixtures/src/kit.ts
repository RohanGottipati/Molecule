import { ProductIntentSchema, type ProductIntent } from "@molecule/contracts";

export function kitIntent(
  now = new Date("2026-09-19T12:00:00.000Z"),
): ProductIntent {
  return ProductIntentSchema.parse({
    intentId: "9e0c7b1a-0000-4000-8000-000000000200",
    version: 1,
    quantity: 200,
    deadline: new Date(now.getTime() + 6 * 86400000).toISOString(),
    currency: "CAD",
    budgetMax: 7000,
    desiredOutputs: [
      {
        outputId: "hoodie",
        name: "Premium black hoodie",
        quantity: 200,
        attributes: {
          product: "hoodie",
          material: "cotton",
          color: "black",
          quality: "premium",
        },
      },
      {
        outputId: "bottle",
        name: "Black bottle",
        quantity: 200,
        attributes: { product: "bottle", color: "black" },
      },
      {
        outputId: "snacks",
        name: "Vegan snacks",
        quantity: 200,
        attributes: { product: "snacks", diet: "vegan" },
      },
    ],
    transformations: [
      {
        transformationId: "embroidery",
        kind: "embroidery",
        description: "Embroider logo on hoodie",
        inputRefs: ["hoodie"],
        outputRefs: ["embroidered_hoodie"],
      },
      {
        transformationId: "engraving",
        kind: "engraving",
        description: "Engrave individual names",
        inputRefs: ["bottle"],
        outputRefs: ["engraved_bottle"],
      },
      {
        transformationId: "assembly",
        kind: "assembly",
        description: "Package individual kits",
        inputRefs: ["embroidered_hoodie", "engraved_bottle", "snacks"],
        outputRefs: ["kit"],
      },
      {
        transformationId: "fulfillment",
        kind: "fulfillment",
        description: "Deliver kits",
        inputRefs: ["kit"],
        outputRefs: ["delivered_kit"],
      },
    ],
    hardConstraints: [
      {
        constraintId: "no-leather",
        field: "material",
        operator: "not_contains",
        value: "leather",
      },
      {
        constraintId: "hoodie-color",
        field: "hoodie.color",
        operator: "eq",
        value: "black",
      },
      {
        constraintId: "vegan",
        field: "snacks.diet",
        operator: "eq",
        value: "vegan",
      },
    ],
    softPreferences: [],
    assets: [],
    ambiguityFlags: [],
  });
}
