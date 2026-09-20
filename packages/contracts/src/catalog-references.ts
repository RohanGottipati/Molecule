import { z } from "zod";

/** Stable local identities survive Shopify reseeding and catalog rollback. */
export const SelectedCatalogItemSchema = z.strictObject({
  bindingId: z.string().min(1),
  productId: z.string().min(1),
  variantId: z.string().min(1),
  sku: z.string().min(1),
  itemKind: z.enum(["physical", "service"]),
  shopDomain: z.string().min(1).optional(),
  variantGid: z
    .string()
    .regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/)
    .optional(),
});

export const CatalogResourceReferenceSchema = z
  .strictObject({
    resourceId: z.string().min(1),
    kind: z.enum(["inventory", "processing"]),
    unit: z.string().min(1),
    unitsPerItem: z.number().positive(),
    available: z.number().nonnegative(),
    periodMinutes: z.number().int().positive().optional(),
    observedAt: z.iso.datetime(),
    sourceReference: z.string().min(1),
    occupiedIntervals: z
      .array(
        z
          .strictObject({
            startsAt: z.iso.datetime(),
            completesAt: z.iso.datetime(),
          })
          .refine(
            (interval) =>
              Date.parse(interval.completesAt) > Date.parse(interval.startsAt),
          ),
      )
      .optional(),
  })
  .superRefine((resource, context) => {
    if (
      (resource.kind === "processing") !==
      (resource.periodMinutes !== undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Only processing resources require periodMinutes",
      });
  });

export const CatalogReferencesShape = {
  catalogVersion: z.string().min(1).optional(),
  selectedItem: SelectedCatalogItemSchema.optional(),
  resourceRefs: z.array(CatalogResourceReferenceSchema).optional(),
  requiredAssetIds: z.array(z.string().min(1)).optional(),
  transferMinutes: z.number().int().nonnegative().optional(),
  synthetic: z.boolean().optional(),
};
export type CatalogResourceReference = z.infer<
  typeof CatalogResourceReferenceSchema
>;
