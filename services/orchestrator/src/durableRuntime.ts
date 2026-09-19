import { Serial } from "./serial.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPool, getOperationsMetrics, getRecentEvents } from "@molecule/db";
import {
  createMerchantRuntime,
  DatabaseCanonicalDataClient,
} from "@molecule/merchant-agents";
import { createRealityService, quoteCatalog, observeCatalogInventory } from "@molecule/service-reality";
import {
  MockShopifyClient,
  RealShopifyClient,
  PostgresShopifyActionRepository,
  ShopifyError,
  ShopifyTransport,
  merchantIdForShopifyStore,
  shopDomain,
  type ShopifyActionRepository,
} from "@molecule/shopify";
import { MockShopifyAdapter } from "@molecule/shopify/catalog";
import {
  MarketplaceSnapshotSchema,
  type ProviderStatus,
} from "@molecule/contracts";
import type { Config } from "./config.js";
import { PostgresStore } from "./PostgresStore.js";
import { DurableExecutionClient } from "./clients/DurableExecutionClient.js";
import {
  ingestShopifyCapacityBatch,
  ingestShopifyInventoryUpdate,
  type ShopifyInventoryUpdate,
} from "./shopifyRealityIngestion.js";

function configuredShopifyStores(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((shop) => shop.trim())
        .filter(Boolean),
    ),
  ];
}

function configuredShopifyDomains(stores: readonly string[]): string[] {
  return stores.map((store) => {
    const normalized = store.trim().toLowerCase();
    return shopDomain(
      normalized.endsWith(".myshopify.com")
        ? normalized
        : `${normalized}.myshopify.com`,
    );
  });
}

export async function createDurableRuntime(config: Config) {
  const store = new PostgresStore();
  let resourceRecovery: ((orderId: string, resourceId: string) => Promise<unknown>) | undefined;
  const recoverySerial = new Serial();
  const drainResourceRecovery = () => recoverySerial.run(async () => {
    if (!resourceRecovery) return;
    const pending = await getPool().query<{ order_id: string; resource_id: string; observation_key: string }>("select * from catalog_recovery_requests where status='pending' order by updated_at");
    for (const request of pending.rows) {
      await resourceRecovery(request.order_id, request.resource_id);
      await getPool().query("update catalog_recovery_requests set status='processed' where order_id=$1 and resource_id=$2 and observation_key=$3", [request.order_id, request.resource_id, request.observation_key]);
    }
  });
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
    recordWebhook: async (...args) => {
      const status = await repository.recordWebhook(...args);
      // The Shopify journal and global Molecule event feed are separate
      // durable stores. Project the webhook immediately; the append is
      // idempotent by event ID, so a duplicate delivery also repairs a
      // previously interrupted projection.
      await store.append(args[3]);
      return status;
    },
  };
  const supplierSchema = z.record(
    z.string(),
    z.object({
      domain: z.string().min(1),
      auth: z.object({ accessToken: z.string().min(1) }),
    }),
  );
  const supplierStores =
    config.SHOPIFY_MODE === "live"
      ? supplierSchema.parse(JSON.parse(config.SHOPIFY_SUPPLIER_STORES!))
      : undefined;
  const mockCatalog =
    config.SHOPIFY_MODE === "demo" ? new MockShopifyAdapter() : undefined;
  const shops = configuredShopifyStores(config.SHOPIFY_STORES);
  const snapshotStores = shops.length ? shops : mockCatalog!.listStores();
  const snapshotSource =
    config.SHOPIFY_MODE === "live"
      ? {
          getSnapshot: async (shop: string) => {
            const merchantId = merchantIdForShopifyStore(shop);
            const supplier = merchantId
              ? supplierStores?.[merchantId]
              : undefined;
            if (!supplier)
              throw new ShopifyError("SUPPLIER_STORE_NOT_CONFIGURED");
            return new ShopifyTransport({
              domain: supplier.domain,
              auth: supplier.auth,
            }).getSnapshot(shop);
          },
        }
      : mockCatalog!;
  const batch = await ingestShopifyCapacityBatch(
    snapshotSource,
    snapshotStores,
    {
      onSkippedStore: (shop) =>
        console.info({
          event: "shopify.reality_ingestion.store_skipped",
          shop,
          reason: "merchant_not_mapped",
        }),
    },
  );
  const syncedAt = new Date().toISOString();
  await store.append({
    eventId: randomUUID(),
    traceId: batch.traceId,
    eventType: "shopify.reality_ingestion.completed",
    severity: "INFO",
    source: "shopify",
    ts: syncedAt,
    payload: {
      syncedAt,
      accepted: batch.accepted,
      quarantined: batch.quarantined,
      skippedStores: batch.skippedStores,
    },
  });
  const commerce =
    config.SHOPIFY_MODE === "live"
      ? new RealShopifyClient({
          repository: journal,
          executionEnabled: config.REAL_EXECUTION_ENABLED,
          centralStore: {
            domain: config.SHOPIFY_STOREFRONT_DOMAIN!,
            auth: { accessToken: config.SHOPIFY_ACCESS_TOKEN! },
          },
          supplierStores: supplierStores!,
        })
      : new MockShopifyClient({ repository: journal });
  return {
    store,
    async attachResourceRecovery(handler: (orderId: string, resourceId: string) => Promise<unknown>) {
      resourceRecovery = handler;
      await drainResourceRecovery();
    },
    reality,
    merchantAgents: {
      ...merchants,
      quote: (request: Parameters<typeof merchants.quote>[0], signal?: AbortSignal) => request.catalogVersion ? quoteCatalog(request) : merchants.quote(request, signal),
    },
    shopify: new DurableExecutionClient(commerce, merchants),
    shopifyWebhook: config.SHOPIFY_API_SECRET
      ? {
          options: {
            secret: config.SHOPIFY_API_SECRET,
            allowedDomains: configuredShopifyDomains(snapshotStores),
            repository: journal,
          },
          ingestInventoryUpdate: async (update: ShopifyInventoryUpdate) => {
            const observed = await observeCatalogInventory(update);
            if (observed.status !== "unmapped") {
              await drainResourceRecovery();
              return;
            }
            // Unknown item/location mappings cannot become merchant-wide capacity.
            const ingested = { status: "skipped" as const };
            if (ingested.status === "skipped") {
              console.info({
                event: "shopify.reality_ingestion.store_skipped",
                shop: update.shop,
                reason: "merchant_not_mapped",
              });
            }
          },
        }
      : undefined,
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
