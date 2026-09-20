import type { FastifyRequest } from "fastify";
import type { Config } from "./config.js";

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

export function chaosAuthorized(
  config: Config,
  request: FastifyRequest,
): boolean {
  if (!config.DEMO_MODE) return false;
  if (LOOPBACK.has(request.ip)) return true;
  return (
    config.CHAOS_SECRET !== undefined &&
    request.headers["x-chaos-secret"] === config.CHAOS_SECRET
  );
}

export function demoResetAvailable(
  config: Config,
  resetDemo: (() => Promise<void>) | undefined,
  request: FastifyRequest,
): boolean {
  return resetDemo !== undefined && chaosAuthorized(config, request);
}
