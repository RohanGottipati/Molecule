import { QuoteRequestSchema } from "@molecule/contracts";
import { closePool, getPool } from "@molecule/db";
import { DatabaseCanonicalDataClient } from "./databaseCanonicalData.js";
import { createMerchantRuntime } from "./runtime.js";
import { createMerchantAgentsServer } from "./server.js";

async function main(): Promise<void> {
  const configuredMode = process.env.MERCHANT_PROVIDER_MODE ?? "demo";
  if (configuredMode !== "demo" && configuredMode !== "live")
    throw new Error("Invalid MERCHANT_PROVIDER_MODE");
  const runtime = createMerchantRuntime({
    canonicalData: new DatabaseCanonicalDataClient(),
    mode: configuredMode,
    backboard:
      configuredMode === "live"
        ? { apiKey: process.env.BACKBOARD_API_KEY ?? "" }
        : undefined,
  });
  await runtime.health();
  const merchants = await getPool().query<{
    merchant_id: string;
    name: string;
  }>("select merchant_id,name from merchants");
  for (const merchant of merchants.rows) {
    await runtime.initialize({
      identity: {
        merchantId: merchant.merchant_id,
        displayName: merchant.name,
        specialty: "Canonical merchant services",
        boundaries: [],
      },
      traceId: `merchant-startup:${merchant.merchant_id}`,
    });
  }
  const server = createMerchantAgentsServer({
    quoteService: {
      handleQuoteRequest: (input, signal) =>
        runtime.quote(QuoteRequestSchema.parse(input), signal),
    },
    memoryService: { listMerchantMemory: runtime.listMemory },
    health: runtime.health,
  });
  const port = Number(process.env.MERCHANT_AGENTS_PORT ?? 3002);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid MERCHANT_AGENTS_PORT");
  server.listen(port, "127.0.0.1");
  const shutdown = () => {
    void runtime.close().then(() =>
      server.close(() => {
        void closePool();
      }),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch(() => {
  console.error(
    "Merchant agents startup failed; verify database migrations and explicit provider configuration.",
  );
  process.exitCode = 1;
  void closePool();
});
