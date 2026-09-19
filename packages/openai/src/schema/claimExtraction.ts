import { z } from "zod";

const ClaimValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
]);

export const ClaimExtractionOutputSchema = z.object({
  candidates: z.array(
    z.object({
      field: z.string(),
      value: ClaimValueSchema,
      normalizedUnit: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      evidenceText: z.string().nullable(),
      ambiguity: z.string().nullable(),
    }),
  ),
});
