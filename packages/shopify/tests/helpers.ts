import {
  ProductionPlanSchema,
  type MoleculeEvent,
  type ProductionPlan,
} from "@molecule/contracts";
import { z } from "zod";
import type {
  OrderJournal,
  ShopifyActionRepository,
} from "../src/repository.js";
import { ShopifyError, type ShopifyOrderState } from "../src/types.js";
import type { RealShopifyEffectsOptions } from "../src/effects.js";

export function plan(overrides: Partial<ProductionPlan> = {}): ProductionPlan {
  return ProductionPlanSchema.parse({
    orderId: "order-release",
    planId: "plan-1",
    intentVersion: 1,
    status: "VALID",
    nodes: [
      {
        nodeId: "hoodie",
        merchantId: "base-goods",
        capabilityId: "cotton-hoodie",
        kind: "SUPPLY",
        quantity: 200,
        unitCost: 12,
        totalCost: 2400,
      },
      {
        nodeId: "embroidery",
        merchantId: "thread-forge",
        capabilityId: "embroidery",
        kind: "TRANSFORM",
        quantity: 200,
        unitCost: 4.5,
        totalCost: 900,
      },
    ],
    edges: [
      {
        edgeId: "edge-1",
        fromNodeId: "hoodie",
        toNodeId: "embroidery",
        material: "cotton",
        quantity: 200,
        unit: "hoodies",
      },
    ],
    totalCost: 3300,
    currency: "CAD",
    riskScore: 0.1,
    constraintResults: [
      {
        constraintId: "solver",
        satisfied: true,
        explanation: "Solver test fixture",
      },
    ],
    ...overrides,
  });
}

export class TestRepository implements ShopifyActionRepository {
  private states = new Map<string, ShopifyOrderState>();
  private log: MoleculeEvent[] = [];
  private deliveries = new Map<string, string>();
  private locks = new Map<string, Promise<void>>();

  async withOrder<T>(
    id: string,
    run: (journal: OrderJournal) => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      id,
      previous.then(() => current),
    );
    await previous;
    try {
      return await run({
        load: () => this.inspect(id),
        save: async (state, event) => {
          this.states.set(id, structuredClone(state));
          this.log.push(structuredClone(event));
        },
      });
    } finally {
      release();
    }
  }
  async inspect(id: string) {
    return structuredClone(this.states.get(id));
  }
  async events(orderId?: string) {
    return this.log.filter((event) => !orderId || event.orderId === orderId);
  }
  async recordWebhook(
    domain: string,
    id: string,
    hash: string,
    event: MoleculeEvent,
  ): Promise<"accepted" | "duplicate"> {
    const key = `${domain}:${id}`;
    const old = this.deliveries.get(key);
    if (old) {
      if (old !== hash) throw new ShopifyError("WEBHOOK_REPLAY_CONFLICT");
      return "duplicate";
    }
    this.deliveries.set(key, hash);
    this.log.push(event);
    return "accepted";
  }
}

const ProductInput = z.object({
  title: z.string(),
  handle: z.string(),
  tags: z.array(z.string()),
  variants: z.array(
    z.object({
      price: z.string(),
      optionValues: z.array(
        z.object({ optionName: z.string(), name: z.string() }),
      ),
    }),
  ),
});
const DraftInput = z.object({
  tags: z.array(z.string()),
  customAttributes: z.array(z.object({ key: z.string(), value: z.string() })),
  lineItems: z.array(z.record(z.string(), z.unknown())).optional(),
});
type Draft = {
  id: string;
  invoiceUrl: string;
  status: string;
  tags: string[];
  totalPriceSet: { presentmentMoney: { amount: string; currencyCode: string } };
};
type Product = {
  id: string;
  tags: string[];
  variants: {
    nodes: { id: string; selectedOptions: { name: string; value: string }[] }[];
    pageInfo: { hasNextPage: boolean };
  };
};
export class FakeShopify {
  calls: {
    operation: string;
    variables: Record<string, unknown>;
    domain: string;
  }[] = [];
  products = new Map<string, Product>();
  drafts = new Map<string, Draft>();
  fail?: (
    operation: string,
    domain: string,
  ) => "lost-response" | "unauthorized" | "bad-input" | undefined;
  hideRecovery = false;
  tax = 0;

  fetch: typeof globalThis.fetch = async (url, init) => {
    const domain = new URL(String(url)).hostname;
    const { query, variables } = z
      .object({
        query: z.string(),
        variables: z.record(z.string(), z.unknown()),
      })
      .parse(JSON.parse(String(init?.body)));
    const operation = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "";
    this.calls.push({ operation, variables, domain });
    const failure = this.fail?.(operation, domain);
    if (failure === "unauthorized")
      return new Response("shpat_do_not_log", { status: 401 });
    const response = (data: unknown) => {
      if (failure === "lost-response")
        throw new Error("connection lost with shpat_do_not_log");
      return Response.json(
        { data },
        { headers: { "x-shopify-api-version": "2026-07" } },
      );
    };
    if (operation === "VerifyStore")
      return response({
        shop: {
          name: "Synthetic store",
          myshopifyDomain: domain,
          currencyCode: "CAD",
        },
        currentAppInstallation: {
          accessScopes: [
            { handle: "write_products" },
            { handle: "write_draft_orders" },
          ],
        },
      });
    if (operation === "SeedLocation")
      return response({
        locations: {
          nodes: [{ id: "gid://shopify/Location/1", isActive: true }],
        },
      });
    if (operation === "Composite" || operation === "SeedProduct") {
      const input = ProductInput.parse(variables.input);
      const existing = this.products.get(`${domain}:${input.handle}`);
      const number = this.products.size + 1;
      const product = {
        id: existing?.id ?? `gid://shopify/Product/${number}`,
        tags: input.tags,
        variants: existing?.variants ?? {
          nodes: input.variants.map((variant, index) => ({
            id: `gid://shopify/ProductVariant/${number}${index}`,
            selectedOptions: variant.optionValues.map((option) => ({
              name: option.optionName,
              value: option.name,
            })),
          })),
          pageInfo: { hasNextPage: false },
        },
      };
      this.products.set(`${domain}:${input.handle}`, product);
      return response({ productSet: { product, userErrors: [] } });
    }
    if (operation === "Product" || operation === "SeedFind") {
      const identifier = z
        .object({ handle: z.string() })
        .parse(variables.identifier);
      return response({
        productByIdentifier: this.hideRecovery
          ? null
          : (this.products.get(`${domain}:${identifier.handle}`) ?? null),
      });
    }
    if (operation === "CreateDraft" || operation === "UpdateDraft") {
      const input = DraftInput.parse(variables.input);
      const key =
        operation === "CreateDraft" ? "draftOrderCreate" : "draftOrderUpdate";
      if (failure === "bad-input" || input.tags.some((tag) => tag.length > 40))
        return response({
          [key]: {
            draftOrder: null,
            userErrors: [{ message: "private provider details" }],
          },
        });
      const id =
        operation === "CreateDraft"
          ? `gid://shopify/DraftOrder/${this.drafts.size + 1}`
          : z.string().parse(variables.id);
      const line = input.lineItems?.[0];
      const money = line
        ? z
            .object({ amount: z.string(), currencyCode: z.string() })
            .parse(line.priceOverride ?? line.originalUnitPriceWithCurrency)
        : undefined;
      const lineTotal = input.lineItems?.reduce((total, item) => {
        const itemMoney = z
          .object({ amount: z.string(), currencyCode: z.string() })
          .parse(item.priceOverride ?? item.originalUnitPriceWithCurrency);
        return (
          total +
          Number(itemMoney.amount) *
            z.number().int().positive().parse(item.quantity)
        );
      }, 0);
      const old = this.drafts.get(`${domain}:${id}`);
      const draft = {
        id,
        invoiceUrl: `https://${domain}/draft_orders/${this.drafts.size + 1}/invoice`,
        status: "OPEN",
        tags: input.tags,
        totalPriceSet: money
          ? {
              presentmentMoney: {
                amount: String(lineTotal! + this.tax),
                currencyCode: money.currencyCode,
              },
            }
          : old!.totalPriceSet,
      };
      this.drafts.set(`${domain}:${id}`, draft);
      return response({ [key]: { draftOrder: draft, userErrors: [] } });
    }
    if (operation === "Draft")
      return response({
        draftOrder:
          this.drafts.get(`${domain}:${String(variables.id)}`) ?? null,
      });
    if (operation === "FindDraft") {
      const tag = z.string().parse(variables.query).slice(4);
      return response({
        draftOrders: {
          nodes: this.hideRecovery
            ? []
            : [...this.drafts.entries()]
                .filter(
                  ([key, value]) =>
                    key.startsWith(`${domain}:`) && value.tags.includes(tag),
                )
                .map(([, value]) => value),
        },
      });
    }
    throw new Error(`Unhandled test operation ${operation}`);
  };

  options(): RealShopifyEffectsOptions {
    const store = (domain: string) => ({
      domain,
      auth: { accessToken: "shpat_test_only" },
      fetch: this.fetch,
    });
    return {
      centralStore: store("molecule.myshopify.com"),
      supplierStores: {
        "base-goods": store("base-goods.myshopify.com"),
        "thread-forge": store("thread-forge.myshopify.com"),
        "needle-north": store("needle-north.myshopify.com"),
      },
      executionEnabled: true,
    };
  }
}
