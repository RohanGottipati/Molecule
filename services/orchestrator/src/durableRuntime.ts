import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPool, getOperationsMetrics, getRecentEvents } from "@molecule/db";
import {
  createMerchantRuntime,
  DatabaseCanonicalDataClient,
} from "@molecule/merchant-agents";
import { createRealityService } from "@molecule/service-reality";
import {
  MockShopifyClient,
  RealShopifyClient,
  PostgresShopifyActionRepository,
  type ShopifyActionRepository,
} from "@molecule/shopify";
import {
  MarketplaceSnapshotSchema,
  type ProviderStatus,
} from "@molecule/contracts";
import type { Config } from "./config.js";
import { PostgresStore } from "./PostgresStore.js";
import { DurableExecutionClient } from "./clients/DurableExecutionClient.js";

export async function createDurableRuntime(config: Config) {
  const store = new PostgresStore();
  await getPool().query("select order_id from order_sessions limit 0");
  const reality = createRealityService();
  const canonical = new DatabaseCanonicalDataClient();
  const merchants = createMerchantRuntime({
    canonicalData: {
      getCapability: async (merchantId, id) => {
        const summaries = await reality.listMerchants();
        return summaries
          .filter(
            (merchant) =>
              merchant.status === "online" &&
              merchant.merchantId === merchantId,
          )
          .flatMap(({ capabilities }) => capabilities)
          .find(
            (candidate) =>
              candidate.capabilityId === id &&
              candidate.blockedReasons.length === 0,
          )?.capability;
      },
      getCanonicalClaims: (merchantId, fields) =>
        canonical.getCanonicalClaims(merchantId, fields),
      getInventory: (merchantId, sku) =>
        canonical.getInventory(merchantId, sku),
    },
    mode: config.BACKBOARD_MODE,
    backboard:
      config.BACKBOARD_MODE === "live"
        ? { apiKey: config.BACKBOARD_API_KEY! }
        : undefined,
  });
  const traceId = randomUUID();
  for (const merchant of await reality.listMerchants()) {
    const initialized = await merchants.initialize({
      traceId,
      identity: {
        merchantId: merchant.merchantId,
        displayName: merchant.name,
        specialty: merchant.capabilities
          .map(({ capability }) => capability.name)
          .join(", "),
        boundaries: merchant.policies,
      },
      memories: merchant.policies,
      documents: merchant.policies.length
        ? [
            {
              fileName: "canonical-policies.txt",
              mimeType: "text/plain",
              category: "materials_policy",
              version: 1,
              sourceTimestamp:
                merchant.claims
                  .map(({ observedAt }) => observedAt)
                  .sort()
                  .at(-1) ?? new Date().toISOString(),
              content: merchant.policies.join("\n"),
            },
          ]
        : [],
    });
    await getPool().query(
      "update merchants set backboard_assistant_id=$2 where merchant_id=$1",
      [merchant.merchantId, initialized.assistantId],
    );
  }
  const repository = new PostgresShopifyActionRepository(
    getPool(),
    `shopify-${config.SHOPIFY_MODE}`,
  );
  for (const event of await repository.events()) await store.append(event);
  const journal: ShopifyActionRepository = {
    withOrder: (id, run) =>
      repository.withOrder(id, (order) =>
        run({
          load: () => order.load(),
          save: async (state, event) => {
            await order.save(state, event);
            await store.append(event);
          },
        }),
      ),
    inspect: (id) => repository.inspect(id),
    events: (id) => repository.events(id),
    recordWebhook: (...args) => repository.recordWebhook(...args),
  };
  const supplierSchema = z.record(
    z.string(),
    z.object({
      domain: z.string().min(1),
      auth: z.object({ accessToken: z.string().min(1) }),
    }),
  );
  const commerce =
    config.SHOPIFY_MODE === "live"
      ? new RealShopifyClient({
          repository: journal,
          executionEnabled: config.REAL_EXECUTION_ENABLED,
          centralStore: {
            domain: config.SHOPIFY_STOREFRONT_DOMAIN!,
            auth: { accessToken: config.SHOPIFY_ACCESS_TOKEN! },
          },
          supplierStores: supplierSchema.parse(
            JSON.parse(config.SHOPIFY_SUPPLIER_STORES!),
          ),
        })
      : new MockShopifyClient({ repository: journal });
  return {
    store,
    reality,
    merchantAgents: merchants,
    shopify: new DurableExecutionClient(commerce, merchants),
    async marketplace(providers: ProviderStatus[]) {
      const summaries = await reality.listMerchants();
      for (const merchant of summaries) {
        merchant.memories = await merchants.listMemory(merchant.merchantId);
        const documents = await merchants.repository.listDocuments(
          merchant.merchantId,
        );
        merchant.documents.push(
          ...documents.map((document) => ({
            documentId: document.documentId,
            name: document.fileName,
            status: "indexed",
          })),
        );
      }
      return MarketplaceSnapshotSchema.parse({
        generatedAt: new Date().toISOString(),
        mode: providers.some(
          ({ name, mode }) => name !== "solver" && mode === "live",
        )
          ? providers.some(
              ({ name, mode }) => name !== "solver" && mode === "demo",
            )
            ? "hybrid"
            : "live"
          : "demo",
        providers,
        merchants: summaries,
        metrics: await getOperationsMetrics(),
        recentEvents: await getRecentEvents(),
      });
    },
    close: () => merchants.close(),
  };
}
