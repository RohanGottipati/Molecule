import { digest, ShopifyError } from "../types.js";
import { SHOPIFY_API_VERSION } from "../transport.js";
import {
  connection,
  fieldArguments,
  matchesSearch,
  paginate,
  parseOperation,
} from "./graphql.js";
import {
  normalizeDomain,
  seedWorld,
  type FakeCustomer,
  type FakeDraftOrder,
  type FakeOrder,
  type FakeProduct,
  type FakeStore,
  type FakeSeedOptions,
  type FakeVariant,
  IdSequence,
} from "./state.js";

/**
 * A local, credential-free Shopify Admin API.
 *
 * It answers the same GraphQL operations the real dev stores do, so `ShopifyTransport`,
 * `RealShopifyClient`, `seedCatalogProduct()` and the operational `.mjs` scripts all run
 * unchanged against it — the only difference is which `fetch` they were handed.
 *
 * Fidelity is deliberate, not incidental: version headers, `userErrors` envelopes, the 40-char
 * draft-tag limit (see docs/SHOPIFY_RELEASE.md), `@idempotent` replay and optional throttling
 * are all reproduced so the real error paths stay exercised rather than bypassed.
 */
export interface FakeShopifyAdminOptions extends FakeSeedOptions {
  /** Emit a THROTTLED error every Nth request, to exercise transport backoff. */
  throttleEvery?: number;
  /** Injects a provider-level failure. Tests use it to drive the recovery paths. */
  requestFailure?: (
    operationName: string,
    domain: string,
  ) => "lost-response" | "unauthorized" | "bad-input" | undefined;
  /** Hides already-created resources, simulating a store that cannot be reconciled. */
  hideRecovery?: boolean;
  /** Extra amount added to draft-order totals, simulating provider-side tax. */
  tax?: number;
  /** Called on every request. Tests use it to inject transport-level failures. */
  beforeRequest?: (context: {
    domain: string;
    operationName: string;
    rootFields: string[];
    variables: Record<string, unknown>;
  }) => void | Promise<void>;
}

interface RequestBody {
  query: string;
  variables?: Record<string, unknown>;
}

export class FakeShopifyAdmin {
  private stores: Map<string, FakeStore>;
  private readonly ids: IdSequence;
  private readonly options: FakeShopifyAdminOptions;
  private requestCount = 0;
  /** Every request, for assertions. Never contains credentials. */
  readonly calls: {
    domain: string;
    operationName: string;
    rootFields: string[];
    variables: Record<string, unknown>;
  }[] = [];
  /** Mutable so a test can flip behavior between two calls on the same instance. */
  requestFailure?: FakeShopifyAdminOptions["requestFailure"];
  hideRecovery: boolean;
  tax: number;

  constructor(options: FakeShopifyAdminOptions = {}) {
    this.options = options;
    this.ids = new IdSequence(options.idStart);
    this.requestFailure = options.requestFailure;
    this.hideRecovery = options.hideRecovery ?? false;
    this.tax = options.tax ?? 0;
    this.stores = seedWorld(options);
  }

  listStores(): string[] {
    return [...this.stores.keys()];
  }

  store(domain: string): FakeStore {
    const store = this.stores.get(normalizeDomain(domain));
    if (!store) throw new ShopifyError("FAKE_STORE_NOT_CONFIGURED");
    return store;
  }

  reset(): void {
    this.stores = seedWorld(this.options);
    this.requestCount = 0;
    this.calls.length = 0;
  }

  /** Direct mutator for demo scripting, bypassing GraphQL. */
  setInventory(
    domain: string,
    inventoryItemId: string,
    quantity: number,
  ): void {
    const store = this.store(domain);
    for (const product of store.products.values()) {
      const variant = product.variants.find(
        (item) =>
          item.inventoryItemId === inventoryItemId ||
          item.id === inventoryItemId ||
          item.sku === inventoryItemId,
      );
      if (variant) {
        variant.quantity = quantity;
        return;
      }
    }
    throw new ShopifyError("FAKE_INVENTORY_ITEM_NOT_FOUND");
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const domain = url.hostname;

    if (url.pathname === "/admin/oauth/access_token") {
      return Response.json({
        access_token: `shpat_fake_${digest(domain).slice(0, 16)}`,
        expires_in: 86_400,
      });
    }

    if (!url.pathname.startsWith(`/admin/api/${SHOPIFY_API_VERSION}/graphql`)) {
      return new Response("not found", { status: 404 });
    }

    let body: RequestBody;
    try {
      body = JSON.parse(String(init?.body)) as RequestBody;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const variables = body.variables ?? {};
    const parsed = parseOperation(body.query);
    this.calls.push({
      domain,
      operationName: parsed.operationName,
      rootFields: parsed.rootFields,
      variables,
    });

    const failure = this.requestFailure?.(parsed.operationName, domain);
    if (failure === "unauthorized") {
      // Rejected before anything is applied, and the body deliberately looks like a token so
      // tests can assert it never reaches a log.
      return new Response("shpat_do_not_log", { status: 401 });
    }
    await this.options.beforeRequest?.({
      domain,
      operationName: parsed.operationName,
      rootFields: parsed.rootFields,
      variables,
    });

    this.requestCount++;
    const throttleEvery = this.options.throttleEvery ?? 0;
    if (throttleEvery > 0 && this.requestCount % throttleEvery === 0) {
      return this.envelope(
        { data: null, errors: [{ extensions: { code: "THROTTLED" } }] },
        429,
      );
    }

    let store: FakeStore;
    try {
      store = this.store(domain);
    } catch {
      return new Response("unknown shop", { status: 404 });
    }

    const data: Record<string, unknown> = {};
    for (const field of parsed.rootFields) {
      const resolver = this.resolvers[field];
      if (!resolver) {
        return this.envelope({
          data: null,
          errors: [
            {
              message: `Fake Shopify: unhandled root field "${field}"`,
              extensions: { code: "UNDEFINED_FIELD" },
            },
          ],
        });
      }
      data[field] = resolver(
        store,
        body.query,
        variables,
        failure === "bad-input",
      );
    }
    if (failure === "lost-response") {
      // The write HAS been applied; only the response is lost. That asymmetry is the whole
      // point of the recovery tests, so the throw has to come after the resolvers run.
      throw new Error("connection lost with shpat_do_not_log");
    }
    return this.envelope({ data });
  };

  private envelope(payload: unknown, status = 200): Response {
    return Response.json(payload, {
      status,
      headers: { "x-shopify-api-version": SHOPIFY_API_VERSION },
    });
  }

  private readonly resolvers: Record<
    string,
    (
      store: FakeStore,
      query: string,
      variables: Record<string, unknown>,
      rejected: boolean,
    ) => unknown
  > = {
    shop: (store) => ({
      name: store.name,
      myshopifyDomain: store.domain,
      currencyCode: store.currencyCode,
    }),

    currentAppInstallation: () => ({
      accessScopes: [
        "read_products",
        "write_products",
        "read_draft_orders",
        "write_draft_orders",
        "read_inventory",
        "write_inventory",
        "read_orders",
        "read_locations",
      ].map((handle) => ({ handle })),
    }),

    locations: (store, query, variables) => {
      const args = fieldArguments(query, "locations", variables);
      return connection(paginate(store.locations, args));
    },

    products: (store, query, variables) => {
      const args = fieldArguments(query, "products", variables);
      const all = [...store.products.values()].filter((product) =>
        matchesSearch(args.query as string | undefined, product),
      );
      const page = paginate(all, args);
      const variantArgs = fieldArguments(query, "variants", variables);
      return connection({
        items: page.items.map((product) =>
          this.productNode(product, variantArgs),
        ),
        pageInfo: page.pageInfo,
      });
    },

    product: (store, query, variables) => {
      const id = variables.id ?? fieldArguments(query, "product", variables).id;
      const product = [...store.products.values()].find(
        (item) => item.id === id,
      );
      if (!product) return null;
      return this.productNode(
        product,
        fieldArguments(query, "variants", variables),
      );
    },

    productByIdentifier: (store, query, variables) => {
      const identifier = (variables.identifier ?? {}) as {
        handle?: string;
        id?: string;
      };
      const product =
        this.hideRecovery || !identifier
          ? undefined
          : identifier.handle
            ? store.products.get(identifier.handle)
            : [...store.products.values()].find(
                (item) => item.id === identifier.id,
              );
      if (!product) return null;
      return this.productNode(
        product,
        fieldArguments(query, "variants", variables),
      );
    },

    inventoryItem: (store, query, variables) => {
      const id = String(variables.id ?? "");
      for (const product of store.products.values()) {
        const variant = product.variants.find(
          (item) => item.inventoryItemId === id,
        );
        if (!variant) continue;
        const levels = store.locations.map((location) => ({
          updatedAt: new Date(
            this.options.now?.getTime() ??
              Date.parse("2026-09-19T12:00:00.000Z"),
          ).toISOString(),
          location: { id: location.id, name: location.name },
          quantities: [{ name: "available", quantity: variant.quantity ?? 0 }],
        }));
        const args = fieldArguments(query, "inventoryLevels", variables);
        return {
          id: variant.inventoryItemId,
          tracked: variant.tracked,
          inventoryLevels: connection(paginate(levels, args)),
        };
      }
      return null;
    },

    productSet: (store, query, variables) =>
      this.productSet(store, query, variables),

    draftOrderCreate: (store, query, variables, rejected) =>
      this.draftMutation(store, variables, "draftOrderCreate", rejected),

    draftOrderUpdate: (store, query, variables, rejected) =>
      this.draftMutation(store, variables, "draftOrderUpdate", rejected),

    draftOrder: (store, query, variables) => {
      const draft = store.draftOrders.get(String(variables.id));
      return draft ? this.draftNode(draft) : null;
    },

    draftOrders: (store, query, variables) => {
      const args = fieldArguments(query, "draftOrders", variables);
      const search = (args.query ?? variables.query) as string | undefined;
      const all = this.hideRecovery
        ? []
        : [...store.draftOrders.values()].filter((draft) =>
            matchesSearch(search, { tags: draft.tags }),
          );
      const page = paginate(all, args);
      return connection({
        items: page.items.map((draft) => this.draftNode(draft)),
        pageInfo: page.pageInfo,
      });
    },

    metafieldDefinitionCreate: (store, query, variables) => {
      const definition = (variables.d ?? variables.definition ?? {}) as {
        namespace?: string;
        key?: string;
      };
      const key = `${definition.namespace}.${definition.key}`;
      if (store.metafieldDefinitions.has(key)) {
        return {
          createdDefinition: null,
          userErrors: [
            {
              code: "TAKEN",
              field: ["key"],
              message: "Definition already exists",
            },
          ],
        };
      }
      store.metafieldDefinitions.set(key, {
        namespace: String(definition.namespace),
        key: String(definition.key),
      });
      return {
        createdDefinition: {
          id: `gid://shopify/MetafieldDefinition/${this.ids.take("MetafieldDefinition")}`,
        },
        userErrors: [],
      };
    },

    metafieldsSet: (store, query, variables) => {
      const inputs = (variables.m ?? variables.metafields ?? []) as {
        ownerId: string;
        namespace: string;
        key: string;
        value: string;
      }[];
      const metafields: { id: string }[] = [];
      const userErrors: { field: string[]; message: string; code: string }[] =
        [];
      for (const input of inputs) {
        const product = [...store.products.values()].find(
          (item) => item.id === input.ownerId,
        );
        if (!product) {
          userErrors.push({
            field: ["ownerId"],
            message: "Owner not found",
            code: "INVALID",
          });
          continue;
        }
        const key = `${input.namespace}.${input.key}`;
        product.metafields.set(key, {
          namespace: input.namespace,
          key: input.key,
          value: input.value,
        });
        metafields.push({
          id: `gid://shopify/Metafield/${digest([product.id, key]).slice(0, 12)}`,
        });
      }
      return { metafields, userErrors };
    },

    inventorySetQuantities: (store, query, variables) => {
      const idempotencyKey =
        typeof variables.k === "string" ? variables.k : undefined;
      const input = (variables.i ?? variables.input ?? {}) as {
        name?: string;
        quantities?: {
          inventoryItemId: string;
          locationId: string;
          quantity: number;
        }[];
      };
      const run = () => {
        const userErrors: {
          field: string[];
          message: string;
          code: string;
        }[] = [];
        for (const entry of input.quantities ?? []) {
          try {
            this.setInventory(
              store.domain,
              entry.inventoryItemId,
              entry.quantity,
            );
          } catch {
            userErrors.push({
              field: ["inventoryItemId"],
              message: "Inventory item not found",
              code: "INVALID",
            });
          }
        }
        return { userErrors };
      };
      if (!idempotencyKey) return run();
      const fingerprint = digest(input);
      const cached = store.idempotency.get(idempotencyKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          return {
            userErrors: [
              {
                field: ["key"],
                message: "Idempotency key reused with different input",
                code: "CONFLICT",
              },
            ],
          };
        }
        return structuredClone(cached.result);
      }
      const result = run();
      store.idempotency.set(idempotencyKey, {
        fingerprint,
        result: structuredClone(result),
      });
      return result;
    },

    orders: (store, query, variables) => {
      const args = fieldArguments(query, "orders", variables);
      const all = [...store.orders.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      const page = paginate(all, args);
      return connection({
        items: page.items.map((order) => this.orderNode(store, order)),
        pageInfo: page.pageInfo,
      });
    },

    order: (store, query, variables) => {
      const order = store.orders.get(String(variables.id));
      return order ? this.orderNode(store, order) : null;
    },

    customers: (store, query, variables) => {
      const args = fieldArguments(query, "customers", variables);
      const all = [...store.customers.values()].sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      );
      const page = paginate(all, args);
      return connection({
        items: page.items.map((customer) => this.customerNode(customer)),
        pageInfo: page.pageInfo,
      });
    },

    customer: (store, query, variables) => {
      const customer = store.customers.get(String(variables.id));
      return customer ? this.customerNode(customer) : null;
    },
  };

  private money(amount: string, currencyCode: string) {
    return {
      presentmentMoney: { amount, currencyCode },
      shopMoney: { amount, currencyCode },
    };
  }

  private orderNode(store: FakeStore, order: FakeOrder) {
    const customer = store.customers.get(order.customerId);
    return {
      id: order.id,
      name: order.name,
      createdAt: order.createdAt,
      processedAt: order.processedAt,
      displayFinancialStatus: order.displayFinancialStatus,
      displayFulfillmentStatus: order.displayFulfillmentStatus,
      currencyCode: order.currencyCode,
      tags: [...order.tags],
      customer: customer ? this.customerNode(customer) : null,
      subtotalPriceSet: this.money(order.subtotal, order.currencyCode),
      totalPriceSet: this.money(order.totalAmount, order.currencyCode),
      lineItems: connection({
        items: order.lineItems.map((line) => ({
          id: line.id,
          title: line.title,
          quantity: line.quantity,
          sku: line.sku,
          variant: { id: line.variantId },
          product: { id: line.productId },
          originalUnitPriceSet: this.money(line.unitPrice, order.currencyCode),
          originalTotalSet: this.money(line.totalPrice, order.currencyCode),
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    };
  }

  private customerNode(customer: FakeCustomer) {
    return {
      id: customer.id,
      displayName: customer.displayName,
      email: customer.email,
      createdAt: customer.createdAt,
      numberOfOrders: String(customer.numberOfOrders),
      amountSpent: {
        amount: customer.amountSpent,
        currencyCode: customer.currencyCode,
      },
      tags: [...customer.tags],
    };
  }

  private productNode(
    product: FakeProduct,
    variantArgs: Record<string, unknown>,
  ) {
    const page = paginate(product.variants, variantArgs, 250);
    return {
      id: product.id,
      handle: product.handle,
      title: product.title,
      status: product.status,
      vendor: product.vendor,
      productType: product.productType,
      description: product.descriptionHtml.replace(/<[^>]+>/g, " ").trim(),
      descriptionHtml: product.descriptionHtml,
      tags: [...product.tags],
      options: product.options,
      variants: connection({
        items: page.items.map((variant) => this.variantNode(variant)),
        pageInfo: page.pageInfo,
      }),
    };
  }

  private variantNode(variant: FakeVariant) {
    return {
      id: variant.id,
      sku: variant.sku,
      title: variant.title,
      price: variant.price,
      inventoryQuantity: variant.quantity,
      selectedOptions: variant.selectedOptions,
      inventoryItem: {
        id: variant.inventoryItemId,
        tracked: variant.tracked,
      },
    };
  }

  private productSet(
    store: FakeStore,
    query: string,
    variables: Record<string, unknown>,
  ) {
    const input = (variables.input ?? variables.i ?? {}) as ProductSetInput;
    const identifier = (variables.identifier ?? variables.id ?? {}) as {
      id?: string;
      handle?: string;
    };
    const existing = identifier.id
      ? [...store.products.values()].find((item) => item.id === identifier.id)
      : store.products.get(String(identifier.handle ?? input.handle));

    const handle = input.handle ?? existing?.handle;
    if (!handle) {
      return {
        product: null,
        userErrors: [{ field: ["handle"], message: "Handle is required" }],
      };
    }

    // Match variants to existing ones by their option-value signature, exactly as
    // packages/shopify/src/seed.ts expects when it reuses variant IDs.
    const bySignature = new Map(
      (existing?.variants ?? []).map((variant) => [
        digest(
          variant.selectedOptions
            .map((option) => [option.name, option.value])
            .sort(),
        ),
        variant,
      ]),
    );

    const variants: FakeVariant[] = (input.variants ?? []).map((variant) => {
      const selectedOptions = (variant.optionValues ?? []).map((option) => ({
        name: option.optionName,
        value: option.name,
      }));
      const signature = digest(
        selectedOptions.map((option) => [option.name, option.value]).sort(),
      );
      const previous =
        (variant.id
          ? (existing?.variants ?? []).find((item) => item.id === variant.id)
          : undefined) ?? bySignature.get(signature);
      const numeric = previous
        ? Number(previous.id.split("/").at(-1))
        : this.ids.take("Variant");
      const tracked =
        variant.inventoryItem?.tracked ?? previous?.tracked ?? false;
      const quantity = tracked
        ? (variant.inventoryQuantities?.[0]?.quantity ??
          previous?.quantity ??
          0)
        : null;
      return {
        id: `gid://shopify/ProductVariant/${numeric}`,
        sku: variant.inventoryItem?.sku ?? previous?.sku ?? "",
        title: selectedOptions.map((option) => option.value).join(" / "),
        price: variant.price ?? previous?.price ?? "0.00",
        selectedOptions,
        inventoryItemId: `gid://shopify/InventoryItem/${numeric}`,
        tracked,
        quantity,
      };
    });

    const product: FakeProduct = {
      id: existing?.id ?? `gid://shopify/Product/${this.ids.take("Product")}`,
      handle,
      title: input.title ?? existing?.title ?? handle,
      vendor: input.vendor ?? existing?.vendor ?? "",
      productType: input.productType ?? existing?.productType ?? "",
      status: input.status ?? existing?.status ?? "DRAFT",
      descriptionHtml: input.descriptionHtml ?? existing?.descriptionHtml ?? "",
      tags: input.tags ? [...new Set(input.tags)] : (existing?.tags ?? []),
      options: (input.productOptions ?? []).map((option, index) => ({
        name: option.name,
        position: option.position ?? index + 1,
        values: (option.values ?? []).map((value) => value.name),
      })),
      variants: variants.length ? variants : (existing?.variants ?? []),
      metafields: existing?.metafields ?? new Map(),
    };
    store.products.set(handle, product);
    return {
      product: this.productNode(
        product,
        fieldArguments(query, "variants", variables),
      ),
      userErrors: [],
    };
  }

  private draftMutation(
    store: FakeStore,
    variables: Record<string, unknown>,
    operation: "draftOrderCreate" | "draftOrderUpdate",
    rejected = false,
  ) {
    const input = (variables.input ?? {}) as DraftOrderInput;
    const tags = input.tags ?? [];
    // The live Admin API caps draft-order tags at 40 characters. Reproducing the limit keeps
    // the regression documented in docs/SHOPIFY_RELEASE.md covered by the fake.
    if (rejected || tags.some((tag) => tag.length > 40)) {
      return {
        draftOrder: null,
        // Real Shopify user errors can echo private provider details; the message stays opaque.
        userErrors: [{ field: ["tags"], message: "private provider details" }],
      };
    }

    const existing =
      operation === "draftOrderUpdate"
        ? store.draftOrders.get(String(variables.id))
        : undefined;
    if (operation === "draftOrderUpdate" && !existing) {
      return {
        draftOrder: null,
        userErrors: [{ field: ["id"], message: "Draft order not found" }],
      };
    }

    const lineItems = (input.lineItems ?? []).map((item) => {
      const money = item.priceOverride ?? item.originalUnitPriceWithCurrency;
      return {
        title: item.title ?? "",
        quantity: item.quantity ?? 1,
        sku: item.sku,
        variantId: item.variantId,
        amount: money?.amount ?? "0.00",
      };
    });

    const currencyCode =
      input.presentmentCurrencyCode ??
      existing?.currencyCode ??
      store.currencyCode;

    const total = lineItems.length
      ? lineItems.reduce(
          (sum, item) => sum + Number(item.amount) * item.quantity,
          0,
        ) + this.tax
      : Number(existing?.totalAmount ?? 0);

    const numeric = existing
      ? Number(existing.id.split("/").at(-1))
      : this.ids.take("DraftOrder");
    const id = existing?.id ?? `gid://shopify/DraftOrder/${numeric}`;
    const draft: FakeDraftOrder = {
      id,
      invoiceUrl:
        existing?.invoiceUrl ??
        `https://${store.domain}/draft_orders/${numeric}/invoice`,
      status: existing?.status ?? "OPEN",
      tags: [...new Set([...(existing?.tags ?? []), ...tags])],
      customAttributes:
        input.customAttributes ?? existing?.customAttributes ?? [],
      lineItems: lineItems.length ? lineItems : (existing?.lineItems ?? []),
      currencyCode,
      totalAmount: (Math.round(total * 100) / 100).toFixed(2),
    };
    store.draftOrders.set(id, draft);
    return { draftOrder: this.draftNode(draft), userErrors: [] };
  }

  private draftNode(draft: FakeDraftOrder) {
    return {
      id: draft.id,
      invoiceUrl: draft.invoiceUrl,
      status: draft.status,
      tags: [...draft.tags],
      totalPriceSet: {
        presentmentMoney: {
          amount: draft.totalAmount,
          currencyCode: draft.currencyCode,
        },
      },
    };
  }
}

interface ProductSetInput {
  title?: string;
  handle?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  status?: string;
  tags?: string[];
  productOptions?: {
    name: string;
    position?: number;
    values?: { name: string }[];
  }[];
  variants?: {
    id?: string;
    optionValues?: { optionName: string; name: string }[];
    price?: string;
    inventoryItem?: { sku?: string; tracked?: boolean };
    inventoryQuantities?: {
      locationId?: string;
      name?: string;
      quantity?: number | null;
    }[];
  }[];
}

interface DraftOrderInput {
  tags?: string[];
  customAttributes?: { key: string; value: string }[];
  presentmentCurrencyCode?: string;
  lineItems?: {
    title?: string;
    quantity?: number;
    sku?: string;
    variantId?: string;
    priceOverride?: { amount: string; currencyCode: string };
    originalUnitPriceWithCurrency?: { amount: string; currencyCode: string };
  }[];
}
