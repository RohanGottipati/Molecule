import { performance } from "node:perf_hooks";

import { RealOpenAIAdapter } from "../packages/openai/src/index.ts";

const apiKey = process.env.OPENAI_API_KEY;
const compilerModel = process.env.OPENAI_COMPILER_MODEL ?? "gpt-5.6-terra";
const realtimeModel = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1";

async function main(): Promise<void> {
  if (!apiKey) {
    console.error(
      "openai.verify blocked reason=OPENAI_API_KEY_missing mock_path_available=true",
    );
    process.exitCode = 2;
    return;
  }
  const adapter = new RealOpenAIAdapter({
    apiKey,
    compilerModel,
    realtimeModel,
  });
  const started = performance.now();
  const result = await adapter.compileIntent({
    orderId: "openai-verification",
    traceId: "openai-verification",
    text: "Make 2 cotton hoodies by 2026-12-31 in CAD",
    locale: "en-CA",
    timeZone: "UTC",
    requestedAt: new Date().toISOString(),
    assets: [],
  });
  if (result.status !== "READY") {
    throw new Error(`Compiler smoke returned ${result.status}`);
  }
  console.log(
    `openai.verify responses ok model=${compilerModel} latency_ms=${Math.round(performance.now() - started)}`,
  );
  const secret = await adapter.mintRealtimeClientSecret("openai-verification");
  if (!secret.expiresAt)
    throw new Error("Realtime client secret had no expiry");
  console.log(
    `openai.verify realtime_client_secret ok model=${realtimeModel} expires_in_s=${Math.max(0, secret.expiresAt - Math.floor(Date.now() / 1000))}`,
  );
}

void main();
