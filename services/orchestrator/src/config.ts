import { z } from "zod";
import { liveShopifyConfiguration } from "./shopifyConfig.js";

const BooleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_COMPILER_MODEL: z.string().default("gpt-5.6-terra"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2.1"),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  USE_MOCK_OPENAI: BooleanString.default(true),
  STORAGE_MODE: z.enum(["local", "postgres"]).default("local"),
  BACKBOARD_MODE: z.enum(["demo", "live"]).default("demo"),
  BACKBOARD_API_KEY: z.string().optional(),
  SHOPIFY_MODE: z.enum(["demo", "live", "fake"]).default("demo"),
  SHOPIFY_API_VERSION: z.literal("2026-07").default("2026-07"),
  SHOPIFY_STOREFRONT_DOMAIN: z.string().optional(),
  MOLECULE_STOREFRONT_DOMAIN: z.string().optional(),
  SHOPIFY_CLIENT_ID: z.string().min(1).optional(),
  SHOPIFY_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_SUPPLIER_STORES: z.string().optional(),
  SHOPIFY_STORES: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().min(1).optional(),
  SOLVER_URL: z.url().default("http://localhost:8000"),
  DEMO_MODE: BooleanString.default(false),
  CHAOS_SECRET: z.string().min(16).optional(),
  REAL_EXECUTION_ENABLED: BooleanString.default(false),
  ALLOWED_ORIGIN: z.string().default("http://localhost:3000"),
  DESKTOP_ORIGIN: z.string().default("http://127.0.0.1:5173"),
  DATA_DIR: z.string().default(".molecule-data"),
  HOST: z.string().default("127.0.0.1"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = ConfigSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "")),
  );
  if (!config.USE_MOCK_OPENAI && !config.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when USE_MOCK_OPENAI=false");
  }
  if (
    config.STORAGE_MODE === "local" &&
    (config.BACKBOARD_MODE === "live" || config.SHOPIFY_MODE === "live")
  )
    throw new Error("Live providers require STORAGE_MODE=postgres");
  // Fake mode drives the same durable pipeline as live (sync -> Postgres -> Reality), so it
  // needs the durable runtime. It needs no credentials and never enables real execution.
  if (config.SHOPIFY_MODE === "fake" && config.STORAGE_MODE !== "postgres")
    throw new Error("SHOPIFY_MODE=fake requires STORAGE_MODE=postgres");
  if (config.SHOPIFY_MODE === "fake" && config.REAL_EXECUTION_ENABLED)
    throw new Error(
      "SHOPIFY_MODE=fake cannot run with REAL_EXECUTION_ENABLED=true",
    );
  if (config.STORAGE_MODE === "postgres" && !env.DATABASE_URL)
    throw new Error("DATABASE_URL is required when STORAGE_MODE=postgres");
  if (config.BACKBOARD_MODE === "live" && !config.BACKBOARD_API_KEY)
    throw new Error("BACKBOARD_API_KEY is required for live Merchant Twins");
  if (config.SHOPIFY_MODE === "live") {
    if (!config.REAL_EXECUTION_ENABLED)
      throw new Error("Live Shopify requires REAL_EXECUTION_ENABLED=true");
    liveShopifyConfiguration(config);
  }
  return config;
}
