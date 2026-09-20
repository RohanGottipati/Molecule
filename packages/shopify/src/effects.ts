import { z } from "zod";
import {
  adminUrl,
  checkoutUrl,
  ShopifyTransport,
  type ShopifyTransportOptions,
} from "./transport.js";
import {
  digest,
  ShopifyError,
  type ShopifyEffect,
  type ShopifyOrderState,
  type ShopifyResource,
} from "./types.js";

export interface ShopifyEffects {
  readonly mode: "mock" | "real";
  readonly binding: string;
  centralDomain: string;
  supplierDomain(merchantId: string): string;
  perform(
    effect: ShopifyEffect,
    state: ShopifyOrderState,
  ): Promise<ShopifyResource>;
  recover(
    effect: ShopifyEffect,
    state: ShopifyOrderState,
  ): Promise<ShopifyResource | undefined>;
}

export interface MockShopifyOptions {
  beforeEffect?: (effect: Readonly<ShopifyEffect>) => Promise<void>;
}

export class MockShopifyEffects implements ShopifyEffects {
  readonly mode = "mock";
  readonly binding = "durable-mock-v1";
  readonly centralDomain = "molecule.mock.local";
  constructor(private readonly options: MockShopifyOptions = {}) {}
  supplierDomain(merchantId: string): string {
    return `${digest(merchantId).slice(0, 16)}.mock.local`;
  }

  async perform(
    effect: ShopifyEffect,
    state: ShopifyOrderState,
  ): Promise<ShopifyResource> {
    await this.options.beforeEffect?.(effect);
    const resource: ShopifyResource = {
      id:
        effect.existing?.id ??
        `gid://molecule-mock/${effect.operation === "product" ? "Product" : "DraftOrder"}/${digest(effect.actionKey)}`,
      domain: effect.domain,
      ...(effect.operation === "product"
        ? {
            variantId:
              effect.existing?.variantId ??
              `gid://molecule-mock/ProductVariant/${digest(effect.actionKey)}`,
          }
        : {}),
      tags: [
        ...new Set([
          ...(effect.existing?.tags ?? []),
          actionTag(effect.actionKey),
          ...(effect.operation === "supersede" ? ["MOLECULE_SUPERSEDED"] : []),
        ]),
      ],
      status: effect.operation === "supersede" ? "SUPERSEDED" : "OPEN",
    };
    state.mockResources[resource.id] = { resource, effect };
    return resource;
  }

  async recover(
    effect: ShopifyEffect,
    state: ShopifyOrderState,
  ): Promise<ShopifyResource> {
    return this.perform(effect, state);
  }
}

export function actionTag(key: string): string {
  return `molecule_action_${digest(key)}`;
}

const UserErrors = z.array(z.object({ message: z.string() }));
const Product = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
  tags: z.array(z.string()),
  variants: z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
        }),
      )
      .min(1),
  }),
});
const Draft = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/DraftOrder\/\d+$/),
  invoiceUrl: z.string().nullable(),
  status: z.string(),
  tags: z.array(z.string()),
  totalPriceSet: z.object({
    presentmentMoney: z.object({
      amount: z.string(),
      currencyCode: z.string(),
    }),
  }),
});
const PRODUCT_FIELDS = "id tags variants(first: 1) { nodes { id } }";
const DRAFT_FIELDS =
  "id invoiceUrl status tags totalPriceSet { presentmentMoney { amount currencyCode } }";

export interface RealShopifyEffectsOptions {
  centralStore: ShopifyTransportOptions;
  supplierStores: Record<string, ShopifyTransportOptions>;
  executionEnabled: boolean;
  checkoutHosts?: string[];
}

export class RealShopifyEffects implements ShopifyEffects {
  readonly mode = "real";
  readonly binding: string;
  readonly centralDomain: string;
  private readonly stores = new Map<string, ShopifyTransport>();
  private readonly suppliers = new Map<string, string>();
  private readonly checkoutHosts: string[];
  private readonly enabled: boolean;

  constructor(options: RealShopifyEffectsOptions) {
    const central = new ShopifyTransport(options.centralStore);
    this.centralDomain = central.domain;
    this.stores.set(central.domain, central);
    for (const [merchant, config] of Object.entries(options.supplierStores)) {
      const transport = new ShopifyTransport(config);
      this.stores.set(transport.domain, transport);
      this.suppliers.set(merchant, transport.domain);
    }
    this.checkoutHosts = options.checkoutHosts ?? [];
    if (
      this.checkoutHosts.some(
        (host) => !/^[a-z0-9.-]+$/.test(host) || host.startsWith("."),
      )
    ) {
      throw new ShopifyError("INVALID_CHECKOUT_HOST");
    }
    this.binding = digest([
      central.domain,
      [...this.suppliers.entries()].sort(),
    ]);
    this.enabled = options.executionEnabled === true;
  }

  assertEnabled(): void {
    if (!this.enabled) throw new ShopifyError("EXECUTION_DISABLED");
  }
  supplierDomain(merchantId: string): string {
    const domain = this.suppliers.get(merchantId);
    if (!domain) throw new ShopifyError("SUPPLIER_STORE_NOT_CONFIGURED");
    return domain;
  }
  transport(domain: string): ShopifyTransport {
    const transport = this.stores.get(domain);
    if (!transport) throw new ShopifyError("STORE_NOT_CONFIGURED");
    return transport;
  }

  private productResource(
    product: z.infer<typeof Product>,
    domain: string,
  ): ShopifyResource {
    return {
      id: product.id,
      domain,
      variantId: product.variants.nodes[0]!.id,
      adminUrl: adminUrl(domain, "products", product.id),
      tags: product.tags,
    };
  }
  private draftResource(
    draft: z.infer<typeof Draft>,
    domain: string,
  ): ShopifyResource {
    return {
      id: draft.id,
      domain,
      adminUrl: adminUrl(domain, "draft_orders", draft.id),
      ...(draft.invoiceUrl
        ? {
            checkoutUrl: checkoutUrl(
              draft.invoiceUrl,
              domain,
              this.checkoutHosts,
            ),
          }
        : {}),
      tags: draft.tags,
      status: draft.status,
      amount: draft.totalPriceSet.presentmentMoney.amount,
      currency: draft.totalPriceSet.presentmentMoney.currencyCode,
    };
  }

  private checkDraft(
    resource: ShopifyResource,
    effect: ShopifyEffect,
  ): ShopifyResource {
    if (resource.status === "COMPLETED")
      throw new ShopifyError("DRAFT_ALREADY_COMPLETED", true, resource);
    if (
      effect.operation !== "supersede" &&
      (resource.currency !== effect.currency ||
        !Number.isFinite(Number(resource.amount)) ||
        Math.abs(Number(resource.amount) - effect.amount) > 0.001)
    ) {
      throw new ShopifyError("DRAFT_TOTAL_REQUIRES_REVIEW", true, resource);
    }
    return resource;
  }

  async perform(effect: ShopifyEffect): Promise<ShopifyResource> {
    this.assertEnabled();
    const transport = this.transport(effect.domain);
    const verified = await transport.verifyStore();
    if (
      verified.shop.myshopifyDomain !== effect.domain ||
      verified.shop.currencyCode !== effect.currency
    ) {
      throw new ShopifyError("STORE_CURRENCY_OR_DOMAIN_MISMATCH");
    }
    const tag = actionTag(effect.actionKey);
    const tags = [
      ...new Set([
        ...(effect.existing?.tags ?? []),
        "MOLECULE",
        tag,
        `molecule_trace_${digest(effect.traceId)}`,
      ]),
    ];
    if (effect.operation === "product") {
      const result = await transport.graphql(
        `mutation Composite($input: ProductSetInput!, $identifier: ProductSetIdentifiers!) {
         productSet(input: $input, identifier: $identifier, synchronous: true) {
         product { ${PRODUCT_FIELDS} } userErrors { message } } }`,
        {
          identifier: effect.existing
            ? { id: effect.existing.id }
            : { handle: effect.handle },
          input: {
            title: effect.title,
            handle: effect.handle,
            status: "DRAFT",
            tags,
            productOptions: [
              {
                name: "Title",
                position: 1,
                values: [{ name: "Complete order" }],
              },
            ],
            variants: [
              {
                ...(effect.existing?.variantId
                  ? { id: effect.existing.variantId }
                  : {}),
                optionValues: [{ optionName: "Title", name: "Complete order" }],
                price: effect.amount.toFixed(2),
                inventoryItem: { tracked: false },
              },
            ],
          },
        },
        z.object({
          productSet: z.object({
            product: Product.nullable(),
            userErrors: UserErrors,
          }),
        }),
        true,
      );
      if (result.productSet.userErrors.length)
        throw new ShopifyError(
          "PRODUCT_REJECTED",
          result.productSet.product !== null,
        );
      if (!result.productSet.product)
        throw new ShopifyError("PRODUCT_MISSING", true);
      return this.productResource(result.productSet.product, effect.domain);
    }
    if (effect.existing) {
      const existing = await this.getDraft(effect.domain, effect.existing.id);
      if (!existing) throw new ShopifyError("DRAFT_MISSING");
      if (existing.status === "COMPLETED")
        throw new ShopifyError("DRAFT_ALREADY_COMPLETED");
      for (const existingTag of existing.tags) {
        if (!tags.includes(existingTag)) tags.push(existingTag);
      }
    }
    const attributes = Object.entries({
      ...effect.attributes,
      molecule_action_key: effect.actionKey,
      molecule_trace_id: effect.traceId,
      molecule_order_id: effect.orderId,
      molecule_plan_id: effect.planId,
    }).map(([key, value]) => ({ key, value }));
    const input =
      effect.operation === "supersede"
        ? {
            tags: [...tags, "MOLECULE_SUPERSEDED"],
            customAttributes: attributes,
          }
        : {
            tags,
            customAttributes: attributes,
            presentmentCurrencyCode: effect.currency,
            acceptAutomaticDiscounts: false,
            allowDiscountCodesInCheckout: false,
            lineItems: [
              {
                quantity: effect.quantity ?? 1,
                ...(effect.variantId
                  ? {
                      variantId: effect.variantId,
                      priceOverride: {
                        amount: (effect.unitAmount ?? effect.amount).toFixed(2),
                        currencyCode: effect.currency,
                      },
                    }
                  : {
                      title: effect.title,
                      ...(effect.sku ? { sku: effect.sku } : {}),
                      originalUnitPriceWithCurrency: {
                        amount: (effect.unitAmount ?? effect.amount).toFixed(2),
                        currencyCode: effect.currency,
                      },
                    }),
                customAttributes: attributes,
              },
              ...(effect.unitAmount !== undefined &&
              Math.round(effect.amount * 100) >
                Math.round(effect.unitAmount * 100) * (effect.quantity ?? 1)
                ? [
                    {
                      title: "Setup / minimum order charge",
                      quantity: 1,
                      originalUnitPriceWithCurrency: {
                        amount: (
                          (Math.round(effect.amount * 100) -
                            Math.round(effect.unitAmount * 100) *
                              (effect.quantity ?? 1)) /
                          100
                        ).toFixed(2),
                        currencyCode: effect.currency,
                      },
                      customAttributes: attributes,
                    },
                  ]
                : []),
            ],
          };
    if (effect.existing) {
      const result = await transport.graphql(
        `mutation UpdateDraft($id: ID!, $input: DraftOrderInput!) {
         draftOrderUpdate(id: $id, input: $input) { draftOrder { ${DRAFT_FIELDS} } userErrors { message } } }`,
        { id: effect.existing.id, input },
        z.object({
          draftOrderUpdate: z.object({
            draftOrder: Draft.nullable(),
            userErrors: UserErrors,
          }),
        }),
        true,
      );
      if (result.draftOrderUpdate.userErrors.length)
        throw new ShopifyError(
          "DRAFT_REJECTED",
          result.draftOrderUpdate.draftOrder !== null,
        );
      if (!result.draftOrderUpdate.draftOrder)
        throw new ShopifyError("DRAFT_MISSING", true);
      return this.checkDraft(
        this.draftResource(result.draftOrderUpdate.draftOrder, effect.domain),
        effect,
      );
    }
    const result = await transport.graphql(
      `mutation CreateDraft($input: DraftOrderInput!) {
       draftOrderCreate(input: $input) { draftOrder { ${DRAFT_FIELDS} } userErrors { message } } }`,
      { input },
      z.object({
        draftOrderCreate: z.object({
          draftOrder: Draft.nullable(),
          userErrors: UserErrors,
        }),
      }),
      true,
    );
    if (result.draftOrderCreate.userErrors.length)
      throw new ShopifyError(
        "DRAFT_REJECTED",
        result.draftOrderCreate.draftOrder !== null,
      );
    if (!result.draftOrderCreate.draftOrder)
      throw new ShopifyError("DRAFT_MISSING", true);
    return this.checkDraft(
      this.draftResource(result.draftOrderCreate.draftOrder, effect.domain),
      effect,
    );
  }

  private async getDraft(domain: string, id: string) {
    const result = await this.transport(domain).graphql(
      `query Draft($id: ID!) { draftOrder(id: $id) { ${DRAFT_FIELDS} } }`,
      { id },
      z.object({ draftOrder: Draft.nullable() }),
    );
    return result.draftOrder
      ? this.draftResource(result.draftOrder, domain)
      : undefined;
  }

  async recover(effect: ShopifyEffect): Promise<ShopifyResource | undefined> {
    const tag = actionTag(effect.actionKey);
    const transport = this.transport(effect.domain);
    if (effect.operation === "product") {
      const result = await transport.graphql(
        `query Product($identifier: ProductIdentifierInput!) {
         productByIdentifier(identifier: $identifier) { ${PRODUCT_FIELDS} } }`,
        { identifier: { handle: effect.handle } },
        z.object({ productByIdentifier: Product.nullable() }),
      );
      return result.productByIdentifier?.tags.includes(tag)
        ? this.productResource(result.productByIdentifier, effect.domain)
        : undefined;
    }
    if (effect.existing) {
      const draft = await this.getDraft(effect.domain, effect.existing.id);
      return draft?.tags.includes(tag)
        ? this.checkDraft(draft, effect)
        : undefined;
    }
    const result = await transport.graphql(
      `query FindDraft($query: String!) { draftOrders(first: 2, query: $query) {
       nodes { ${DRAFT_FIELDS} } } }`,
      { query: `tag:${tag}` },
      z.object({ draftOrders: z.object({ nodes: z.array(Draft) }) }),
    );
    if (result.draftOrders.nodes.length > 1)
      throw new ShopifyError("DUPLICATE_PROVIDER_RESOURCES", true);
    const draft = result.draftOrders.nodes[0];
    return draft?.tags.includes(tag)
      ? this.checkDraft(this.draftResource(draft, effect.domain), effect)
      : undefined;
  }
}
