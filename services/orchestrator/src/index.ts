import { pathToFileURL } from "node:url";

import {
  GoldenPathOpenAIAdapter,
  MockOpenAIAdapter,
  RealOpenAIAdapter,
} from "@molecule/openai";
import {
  MarketplaceSnapshotSchema,
  OperationsMetricsSchema,
  type ProviderStatus,
} from "@molecule/contracts";
import { catalogGallery } from "@molecule/service-reality";
import { closePool, getPool } from "@molecule/db";

import { HttpSolverClient } from "./clients/HttpSolverClient.js";
import { readConfig } from "./config.js";
import { LocalStore } from "./LocalStore.js";
import { MockMerchantAgentClient } from "./mocks/MockMerchantAgentClient.js";
import { MockRealityClient } from "./mocks/MockRealityClient.js";
import { MockShopifyClient } from "./mocks/MockShopifyClient.js";
import { buildServer } from "./server.js";
import { Orchestrator } from "./workflow/Orchestrator.js";
import { createDurableRuntime } from "./durableRuntime.js";
import { demoCandidates } from "./mocks/demoCatalog.js";

export async function createApp() {
  const config = readConfig();
  const durable =
    config.STORAGE_MODE === "postgres"
      ? await createDurableRuntime(config)
      : undefined;
  const local = new LocalStore(config.DATA_DIR);
  if (!durable) await local.load();
  const store = durable?.store ?? local;
  const sessions = store;
  const events = store;
  const compiler = config.USE_MOCK_OPENAI
    ? new MockOpenAIAdapter()
    : new RealOpenAIAdapter({
        apiKey: config.OPENAI_API_KEY!,
        compilerModel: config.OPENAI_COMPILER_MODEL,
        realtimeModel: config.OPENAI_REALTIME_MODEL,
        transcriptionModel: config.OPENAI_TRANSCRIPTION_MODEL,
      });
  const openai = config.DEMO_MODE
    ? new GoldenPathOpenAIAdapter(compiler)
    : compiler;
  const solver = new HttpSolverClient(config.SOLVER_URL);
  const orchestrator = new Orchestrator({
    sessions,
    events,
    contexts: store,
    openai,
    reality:
      durable?.reality ?? new MockRealityClient(() => local.offlineMerchants()),
    merchantAgents: durable?.merchantAgents ?? new MockMerchantAgentClient(),
    solver,
    shopify: durable?.shopify ?? new MockShopifyClient(),
    quoteTimeoutMs: 30_000,
  });
  await durable?.attachResourceRecovery((orderId, resourceId) =>
    orchestrator.recoverResource(orderId, resourceId),
  );
  const solverHealthy = () =>
    fetch(`${config.SOLVER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    })
      .then((response) => response.ok)
      .catch(() => false);
  const providers = async (): Promise<ProviderStatus[]> => {
    const solverReady = await solverHealthy();
    return [
      {
        name: "openai",
        mode: config.USE_MOCK_OPENAI ? "demo" : "live",
        status: "ready",
        detail: [
          config.USE_MOCK_OPENAI
            ? "Deterministic intent compiler"
            : "OpenAI configured; credentials checked on request",
          ...(config.DEMO_MODE ? ["golden-path brief pinned"] : []),
        ].join("; "),
      },
      {
        name: "backboard",
        mode: config.BACKBOARD_MODE,
        status: "ready",
        detail: durable
          ? "Persistent Merchant Twins, canonical tools and PostgreSQL memory"
          : "Synthetic local quotes; use PostgreSQL for persistent twins",
      },
      {
        name: "shopify",
        mode: config.SHOPIFY_MODE,
        status: "ready",
        detail:
          config.SHOPIFY_MODE === "live"
            ? "Authorized Shopify adapter; credentials checked on commit"
            : "Synthetic commerce; no external orders or charges",
      },
      {
        name: "tiger",
        mode: durable && !config.DEMO_MODE ? "live" : "demo",
        status: "ready",
        detail: durable
          ? "PostgreSQL sessions, reservations and event log"
          : "Local file persistence",
      },
      {
        name: "rox",
        mode: durable && !config.DEMO_MODE ? "live" : "demo",
        status: "ready",
        detail: durable
          ? "Canonical provenance and lexical candidate search"
          : "Synthetic in-process catalog",
      },
      {
        name: "solver",
        mode: solverReady ? "live" : "unavailable",
        status: solverReady ? "ready" : "unavailable",
        detail: solverReady
          ? "OR-Tools CP-SAT; sole feasibility authority"
          : "Solver health check failed",
      },
    ];
  };
  const marketplace = async () => {
    const statuses = await providers();
    if (durable) return durable.marketplace(statuses);
    const recentEvents = local.recentEvents();
    const candidates = demoCandidates();
    return MarketplaceSnapshotSchema.parse({
      generatedAt: new Date().toISOString(),
      mode: "demo",
      providers: statuses,
      merchants: [
        ...new Set(candidates.map(({ merchantId }) => merchantId)),
      ].map((merchantId) => ({
        merchantId,
        name: merchantId
          .split("-")
          .map((part) => part[0]!.toUpperCase() + part.slice(1))
          .join(" "),
        status: local.offlineMerchants().has(merchantId) ? "offline" : "online",
        capabilities: candidates.filter(
          (item) => item.merchantId === merchantId,
        ),
        claims: [],
        memories: [],
        policies: ["Synthetic local demonstration"],
        documents: [],
      })),
      metrics: OperationsMetricsSchema.parse(local.metrics()),
      recentEvents,
    });
  };
  const app = await buildServer({
    readiness: async () => {
      const [solver, persistence] = await Promise.all([
        solverHealthy(),
        durable
          ? getPool()
              .query("select 1")
              .then(() => true)
              .catch(() => false)
          : Promise.resolve(true),
      ]);
      return { solver, persistence };
    },
    config,
    sessions,
    events,
    orchestrator,
    solver,
    openai,
    desktopStore: store,
    marketplace,
    applyChaos: durable?.reality.applyChaos,
    resetDemo: durable?.reality.resetDemo,
    shopifyWebhook: durable?.shopifyWebhook,
    catalogGallery: durable ? catalogGallery : undefined,
  });
  app.addHook("onClose", async () => {
    await durable?.close();
    if (durable) await closePool();
  });
  return { app, config };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const { app, config } = await createApp();
  await app.listen({ port: config.PORT, host: config.HOST });
}
