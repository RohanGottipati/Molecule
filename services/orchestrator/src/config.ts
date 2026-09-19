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
  const config = ConfigSchema.parse(env);
  if (!config.USE_MOCK_OPENAI && !config.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when USE_MOCK_OPENAI=false");
  }
  return config;
}
