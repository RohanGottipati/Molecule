import { z } from "zod";
import { ConstraintOperatorSchema } from "@molecule/contracts";

const NullableString = z.string().max(600).nullable();
export const ExtractionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
]);

const ExtractionAttributeSchema = z.strictObject({
  name: z.string(),
  value: ExtractionValueSchema,
});

const ExtractionConstraintSchema = z.strictObject({
  key: z.string(),
  field: z.string(),
  operator: ConstraintOperatorSchema,
  value: ExtractionValueSchema,
  unit: NullableString,
  description: NullableString,
});

export const IntentExtractionSchema = z.strictObject({
  outcome: z.enum(["EXTRACTED", "NEEDS_CLARIFICATION", "UNSUPPORTED"]),
  unsupportedReason: NullableString,
  quantity: z.number().int().positive().nullable(),
  deadline: z.string().datetime().nullable(),
  currency: z.enum(["CAD", "USD"]).nullable(),
  budgetMax: z.number().positive().nullable(),
  desiredOutputs: z.array(
    z.strictObject({
      key: z.string(),
      name: z.string(),
      quantity: z.number().int().positive().nullable(),
      attributes: z.array(ExtractionAttributeSchema),
    }),
  ),
  transformations: z.array(
    z.strictObject({
      key: z.string(),
      kind: z.string(),
      description: z.string().max(600),
      inputKeys: z.array(z.string()),
      outputKeys: z.array(z.string()),
    }),
  ),
  hardConstraints: z.array(ExtractionConstraintSchema),
  softPreferences: z.array(
    ExtractionConstraintSchema.extend({
      weight: z.number().min(0).max(1),
    }),
  ),
  ambiguityFlags: z.array(
    z.strictObject({
      field: z.string(),
      reason: z.string().max(600),
      question: z.string().max(600),
    }),
  ),
});

export type IntentExtraction = z.infer<typeof IntentExtractionSchema>;
