import { z } from "zod";
import { ConstraintOperatorSchema } from "@molecule/contracts";

const NullableString = z.string().nullable();
const ExtractionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
]);

const ExtractionAttributeSchema = z.object({
  name: z.string(),
  value: ExtractionValueSchema,
});

const ExtractionConstraintSchema = z.object({
  key: z.string(),
  field: z.string(),
  operator: ConstraintOperatorSchema,
  value: ExtractionValueSchema,
  unit: NullableString,
  description: NullableString,
});

export const IntentExtractionSchema = z.object({
  outcome: z.enum(["EXTRACTED", "NEEDS_CLARIFICATION", "UNSUPPORTED"]),
  unsupportedReason: NullableString,
  quantity: z.number().int().positive().nullable(),
  deadline: z.string().datetime().nullable(),
  currency: z.enum(["CAD", "USD"]).nullable(),
  budgetMax: z.number().positive().nullable(),
  desiredOutputs: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      quantity: z.number().int().positive().nullable(),
      attributes: z.array(ExtractionAttributeSchema),
    }),
  ),
  transformations: z.array(
    z.object({
      key: z.string(),
      kind: z.string(),
      description: z.string(),
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
    z.object({
      field: z.string(),
      reason: z.string(),
      question: z.string(),
    }),
  ),
});

export type IntentExtraction = z.infer<typeof IntentExtractionSchema>;
