import { z } from "zod";
import { actionTag } from "./effects.js";
import { eventFor, type ShopifyActionRepository } from "./repository.js";
import { adminUrl, ShopifyTransport } from "./transport.js";
import {
  actionKey,
  digest,
  ShopifyError,
  type ActionRecord,
  type ShopifyOrderState,
} from "./types.js";

const CatalogProductSchema = z.object({
  title: z.string().min(1),
  handle: z.string().regex(/^[a-z0-9-]+$/),
  descriptionHtml: z.string(),
  vendor: z.string(),
  type: z.string(),
  tags: z.array(z.string()),
  options: z.record(z.string(), z.array(z.string())).nullable().optional(),
  variants: z
    .array(
      z.object({
        optionValues: z.array(
          z.object({ optionName: z.string(), name: z.string() }),
        ),
        price: z.string().regex(/^\d+\.\d{2}$/),
        sku: z.string(),
        tracked: z.boolean(),
        quantity: z.number().int().nonnegative().nullable(),
      }),
    )
    .min(1)
    .max(250),
});

export async function seedCatalogProduct(options: {
  transport: ShopifyTransport;
  repository: ShopifyActionRepository;
  product: unknown;
  traceId: string;
  executionEnabled: boolean;
}): Promise<{ id: string; actionKey: string; reused: boolean }> {
  if (!options.executionEnabled || !options.traceId.trim())
    throw new ShopifyError("SEED_EXECUTION_DISABLED");
  const parsed = CatalogProductSchema.safeParse(options.product);
  if (!parsed.success) throw new ShopifyError("INVALID_SEED_PRODUCT");
  const product = parsed.data;
  if (!product.tags.includes("MOLECULE_DEMO"))
    throw new ShopifyError("SYNTHETIC_LABEL_REQUIRED");
  if (
    product.variants.some(
      (variant) => variant.tracked && variant.quantity === null,
    )
  )
    throw new ShopifyError("SEED_QUANTITY_REQUIRED");
  const { transport, repository, traceId } = options;
  const orderId = `shopify-seed:${transport.domain}`;
  const key = actionKey(
    "seed",
    transport.domain,
    product.handle,
    digest(product),
  );
  return repository.withOrder(orderId, async (journal) => {
    const state: ShopifyOrderState = (await journal.load()) ?? {
      version: 1,
      mode: "real",
      binding: `seed:${transport.domain}`,
      orderId,
      plans: {},
      actions: {},
      mockResources: {},
    };
    if (state.binding !== `seed:${transport.domain}` || state.mode !== "real")
      throw new ShopifyError("REPOSITORY_BINDING_MISMATCH");
    const previous = state.actions[key];
    const productSchema = z.object({
      id: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
      tags: z.array(z.string()),
      variants: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            selectedOptions: z.array(
              z.object({ name: z.string(), value: z.string() }),
            ),
          }),
        ),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
    });
    const fields =
      "id tags variants(first: 250) { nodes { id selectedOptions { name value } } pageInfo { hasNextPage } }";
    const found = await transport.graphql(
      `query SeedFind($identifier: ProductIdentifierInput!) { productByIdentifier(identifier: $identifier) { ${fields} } }`,
      { identifier: { handle: product.handle } },
      z.object({ productByIdentifier: productSchema.nullable() }),
    );
    if (previous?.receipt.status === "SUCCEEDED" && previous.resource) {
      if (!found.productByIdentifier?.tags.includes(actionTag(key)))
        throw new ShopifyError("SEED_CATALOG_DRIFT");
      return { id: previous.resource.id, actionKey: key, reused: true };
    }
    if (previous?.receipt.status === "PENDING") {
      if (!found.productByIdentifier?.tags.includes(actionTag(key)))
        throw new ShopifyError("SEED_OUTCOME_UNKNOWN");
      previous.resource = {
        id: found.productByIdentifier.id,
        domain: transport.domain,
        adminUrl: adminUrl(
          transport.domain,
          "products",
          found.productByIdentifier.id,
        ),
        tags: found.productByIdentifier.tags,
      };
      previous.receipt = {
        actionKey: key,
        kind: "COMPOSITE_PRODUCT",
        status: "SUCCEEDED",
        providerRef: previous.resource.id,
      };
      await journal.save(
        state,
        eventFor(
          traceId,
          "shopify.seed.reconciled",
          { actionKey: key, providerRef: previous.resource.id },
          orderId,
        ),
      );
      return { id: previous.resource.id, actionKey: key, reused: true };
    }
    if (
      found.productByIdentifier &&
      !found.productByIdentifier.tags.includes("MOLECULE_DEMO")
    )
      throw new ShopifyError("SEED_HANDLE_NOT_OWNED");
    if (found.productByIdentifier?.variants.pageInfo.hasNextPage)
      throw new ShopifyError("SEED_VARIANT_LIMIT");
    const existingVariants = new Map(
      found.productByIdentifier?.variants.nodes.map((variant) => [
        digest(
          variant.selectedOptions
            .map((option) => [option.name, option.value])
            .sort(),
        ),
        variant.id,
      ]),
    );
    if (
      Object.values(state.actions).some(
        (action) =>
          action.effect.handle === product.handle &&
          action.receipt.status === "PENDING",
      )
    ) {
      throw new ShopifyError("SEED_PREVIOUS_OUTCOME_UNKNOWN");
    }
    const shop = await transport.verifyStore();
    if (shop.shop.currencyCode !== "CAD")
      throw new ShopifyError("SEED_REQUIRES_CAD");
    let locationId: string | undefined;
    if (product.variants.some((variant) => variant.tracked)) {
      const result = await transport.graphql(
        "query SeedLocation { locations(first: 100) { nodes { id isActive } } }",
        {},
        z.object({
          locations: z.object({
            nodes: z.array(z.object({ id: z.string(), isActive: z.boolean() })),
          }),
        }),
      );
      locationId = result.locations.nodes.find(
        (location) => location.isActive,
      )?.id;
      if (!locationId) throw new ShopifyError("SEED_LOCATION_REQUIRED");
    }
    const record: ActionRecord = {
      effect: {
        operation: "product",
        domain: transport.domain,
        actionKey: key,
        traceId,
        orderId,
        planId: "synthetic-catalog",
        handle: product.handle,
        title: product.title,
        amount: Number(product.variants[0]!.price),
        currency: "CAD",
        attributes: { catalogHash: digest(product) },
      },
      receipt: { actionKey: key, kind: "COMPOSITE_PRODUCT", status: "PENDING" },
    };
    state.actions[key] = record;
    await journal.save(
      state,
      eventFor(
        traceId,
        "shopify.seed.pending",
        { actionKey: key, handle: product.handle },
        orderId,
      ),
    );
    let failure: ShopifyError | undefined;
    try {
      const result = await transport.graphql(
        `mutation SeedProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers!) {
         productSet(input: $input, identifier: $identifier, synchronous: true) {
         product { ${fields} } userErrors { message } } }`,
        {
          identifier: found.productByIdentifier
            ? { id: found.productByIdentifier.id }
            : { handle: product.handle },
          input: {
            title: product.title,
            handle: product.handle,
            descriptionHtml: product.descriptionHtml,
            vendor: product.vendor,
            productType: product.type,
            status: "DRAFT",
            tags: [
              ...product.tags,
              actionTag(key),
              `molecule_trace_${digest(traceId)}`,
            ],
            productOptions: Object.entries(
              product.options ?? { Title: ["Default Title"] },
            ).map(([name, values], index) => ({
              name,
              position: index + 1,
              values: values.map((name) => ({ name })),
            })),
            variants: product.variants.map((variant) => ({
              id: existingVariants.get(
                digest(
                  variant.optionValues
                    .map((option) => [option.optionName, option.name])
                    .sort(),
                ),
              ),
              optionValues: variant.optionValues,
              price: variant.price,
              inventoryItem: { sku: variant.sku, tracked: variant.tracked },
              ...(variant.tracked
                ? {
                    inventoryQuantities: [
                      {
                        locationId,
                        name: "available",
                        quantity: variant.quantity,
                      },
                    ],
                  }
                : {}),
            })),
          },
        },
        z.object({
          productSet: z.object({
            product: productSchema.nullable(),
            userErrors: z.array(z.object({ message: z.string() })),
          }),
        }),
        true,
      );
      if (result.productSet.userErrors.length)
        throw new ShopifyError(
          "SEED_PRODUCT_REJECTED",
          result.productSet.product !== null,
        );
      if (!result.productSet.product)
        throw new ShopifyError("SEED_PRODUCT_MISSING", true);
      record.resource = {
        id: result.productSet.product.id,
        domain: transport.domain,
        adminUrl: adminUrl(
          transport.domain,
          "products",
          result.productSet.product.id,
        ),
        tags: result.productSet.product.tags,
      };
      record.receipt = {
        actionKey: key,
        kind: "COMPOSITE_PRODUCT",
        status: "SUCCEEDED",
        providerRef: record.resource.id,
      };
    } catch (error) {
      failure =
        error instanceof ShopifyError
          ? error
          : new ShopifyError("SEED_PROVIDER_ERROR", true);
      record.receipt = {
        actionKey: key,
        kind: "COMPOSITE_PRODUCT",
        status: failure.uncertain ? "PENDING" : "FAILED",
        errorCode: failure.code,
      };
    }
    await journal.save(
      state,
      eventFor(
        traceId,
        failure ? "shopify.seed.failed" : "shopify.seed.succeeded",
        { ...record.receipt },
        orderId,
      ),
    );
    if (failure) throw failure;
    return { id: record.resource!.id, actionKey: key, reused: false };
  });
}
