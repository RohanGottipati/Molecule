import { pathToFileURL } from "node:url";

import { MockOpenAIAdapter, RealOpenAIAdapter } from "@molecule/openai";

import { HttpSolverClient } from "./clients/HttpSolverClient.js";
import { readConfig } from "./config.js";
import { LocalStore } from "./LocalStore.js";
import { MockMerchantAgentClient } from "./mocks/MockMerchantAgentClient.js";
import { MockRealityClient } from "./mocks/MockRealityClient.js";
import { MockShopifyClient } from "./mocks/MockShopifyClient.js";
import { buildServer } from "./server.js";
import { Orchestrator } from "./workflow/Orchestrator.js";

export async function createApp() {
  const config = readConfig();
  const store = new LocalStore(config.DATA_DIR);
  await store.load();
  const sessions = store;
  const events = store;
  const openai = config.USE_MOCK_OPENAI
    ? new MockOpenAIAdapter()
    : new RealOpenAIAdapter({
        apiKey: config.OPENAI_API_KEY!,
        compilerModel: config.OPENAI_COMPILER_MODEL,
        realtimeModel: config.OPENAI_REALTIME_MODEL,
        transcriptionModel: config.OPENAI_TRANSCRIPTION_MODEL,
      });
  const solver = new HttpSolverClient(config.SOLVER_URL);
  const orchestrator = new Orchestrator({
    sessions,
    events,
    openai,
    reality: new MockRealityClient(),
    merchantAgents: new MockMerchantAgentClient(),
    solver,
    shopify: new MockShopifyClient(),
  });
  return {
    app: await buildServer({
      config,
      sessions,
      events,
      orchestrator,
      solver,
      openai,
      desktopStore: store,
    }),
    config,
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const { app, config } = await createApp();
  await app.listen({ port: config.PORT, host: config.HOST });
}
