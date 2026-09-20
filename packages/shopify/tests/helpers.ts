import {
  ProductionPlanSchema,
  type MoleculeEvent,
  type ProductionPlan,
} from "@molecule/contracts";
import type {
  OrderJournal,
  ShopifyActionRepository,
} from "../src/repository.js";
import { FakeShopifyAdmin } from "../src/fake/admin.js";
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

/**
 * Test-facing facade over the shared `FakeShopifyAdmin`.
 *
 * There is exactly ONE implementation of fake Admin API semantics (`src/fake/`), so the fake
 * these tests assert against is the same one `SHOPIFY_MODE=fake` serves in the orchestrator.
 * This class only adapts its shape to what the suite reads: operation-name call records and
 * flat `products` / `drafts` maps keyed `domain:key`.
 */
export class FakeShopify {
  readonly admin: FakeShopifyAdmin;

  constructor() {
    this.admin = new FakeShopifyAdmin({
      stores: [
        "molecule.myshopify.com",
        "base-goods.myshopify.com",
        "thread-forge.myshopify.com",
        "needle-north.myshopify.com",
      ],
      // Durable-execution tests create every resource by mutation; a seeded catalog would
      // only add noise to the `products` / `drafts` size assertions.
      seedCatalog: false,
      seedCommerce: false,
      // The suite asserts literal Admin URLs and GIDs, so number from 1.
      idStart: 1,
    });
  }

  get calls(): {
    operation: string;
    variables: Record<string, unknown>;
    domain: string;
  }[] {
    return this.admin.calls.map((call) => ({
      operation: call.operationName,
      variables: call.variables,
      domain: call.domain,
    }));
  }

  get products(): Map<string, { id: string; tags: string[] }> {
    const out = new Map<string, { id: string; tags: string[] }>();
    for (const domain of this.admin.listStores()) {
      for (const product of this.admin.store(domain).products.values()) {
        out.set(`${domain}:${product.handle}`, product);
      }
    }
    return out;
  }

  get drafts(): Map<string, { id: string; tags: string[]; status: string }> {
    const out = new Map<
      string,
      { id: string; tags: string[]; status: string }
    >();
    for (const domain of this.admin.listStores()) {
      for (const draft of this.admin.store(domain).draftOrders.values()) {
        out.set(`${domain}:${draft.id}`, draft);
      }
    }
    return out;
  }

  set fail(
    value:
      | ((
          operation: string,
          domain: string,
        ) => "lost-response" | "unauthorized" | "bad-input" | undefined)
      | undefined,
  ) {
    this.admin.requestFailure = value;
  }
  get fail() {
    return this.admin.requestFailure;
  }

  set hideRecovery(value: boolean) {
    this.admin.hideRecovery = value;
  }
  get hideRecovery(): boolean {
    return this.admin.hideRecovery;
  }

  set tax(value: number) {
    this.admin.tax = value;
  }
  get tax(): number {
    return this.admin.tax;
  }

  get fetch(): typeof globalThis.fetch {
    return this.admin.fetch;
  }

  options(): RealShopifyEffectsOptions {
    const store = (domain: string) => ({
      domain,
      auth: { accessToken: "shpat_test_only" },
      fetch: this.admin.fetch,
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
