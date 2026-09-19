import { z } from "zod";

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
  SHOPIFY_MODE: z.enum(["demo", "live"]).default("demo"),
  SHOPIFY_API_VERSION: z.literal("2026-07").default("2026-07"),
  SHOPIFY_STOREFRONT_DOMAIN: z.string().optional(),
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
  if (config.STORAGE_MODE === "postgres" && !env.DATABASE_URL)
    throw new Error("DATABASE_URL is required when STORAGE_MODE=postgres");
  if (config.BACKBOARD_MODE === "live" && !config.BACKBOARD_API_KEY)
    throw new Error("BACKBOARD_API_KEY is required for live Merchant Twins");
  if (
    config.SHOPIFY_MODE === "live" &&
    (!config.REAL_EXECUTION_ENABLED ||
      !config.SHOPIFY_STOREFRONT_DOMAIN ||
      !config.SHOPIFY_ACCESS_TOKEN ||
      !config.SHOPIFY_SUPPLIER_STORES ||
      !config.SHOPIFY_STORES)
  )
    throw new Error(
      "Live Shopify requires execution authorization and store credentials",
    );
  return config;
}
