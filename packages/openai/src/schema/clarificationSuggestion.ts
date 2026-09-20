import { z } from "zod";

export const ClarificationSuggestionSchema = z.strictObject({
  questions: z.array(
    z.strictObject({
      question: z.string().max(600),
      options: z
        .array(
          z.strictObject({
            label: z.string().max(120),
            value: z.string().max(400),
            hint: z.string().max(200).nullable(),
          }),
        )
        .max(6),
      inputHint: z.string().max(160).nullable(),
    }),
  ),
});

export type ClarificationSuggestion = z.infer<
  typeof ClarificationSuggestionSchema
>;
