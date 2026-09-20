import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "./config.js";
import { chaosAuthorized, demoResetAvailable } from "./demoAuthorization.js";

const SECRET = "chaos-secret-0123456789abcdef";

async function probe(
  config: Config,
  resetDemo: (() => Promise<void>) | undefined,
  options: { remoteAddress: string; secret?: string },
) {
  const app = Fastify();
  app.get("/probe", async (request) => ({
    chaos: chaosAuthorized(config, request),
    reset: demoResetAvailable(config, resetDemo, request),
  }));
  const response = await app.inject({
    url: "/probe",
    remoteAddress: options.remoteAddress,
    headers: options.secret ? { "x-chaos-secret": options.secret } : {},
  });
  await app.close();
  return response.json() as { chaos: boolean; reset: boolean };
}

describe("demo authorization", () => {
  const reset = async () => {};
  const demo = ConfigSchema.parse({ DEMO_MODE: "true", CHAOS_SECRET: SECRET });

  it("authorizes loopback requests in demo mode", async () => {
    expect(await probe(demo, reset, { remoteAddress: "127.0.0.1" })).toEqual({
      chaos: true,
      reset: true,
    });
    expect(await probe(demo, reset, { remoteAddress: "::1" })).toEqual({
      chaos: true,
      reset: true,
    });
  });

  it("requires the chaos secret for remote requests", async () => {
    expect(await probe(demo, reset, { remoteAddress: "10.0.0.8" })).toEqual({
      chaos: false,
      reset: false,
    });
    expect(
      await probe(demo, reset, { remoteAddress: "10.0.0.8", secret: "wrong" }),
    ).toEqual({ chaos: false, reset: false });
    expect(
      await probe(demo, reset, { remoteAddress: "10.0.0.8", secret: SECRET }),
    ).toEqual({ chaos: true, reset: true });
  });

  it("never advertises reset without a reset function or outside demo mode", async () => {
    expect(
      await probe(demo, undefined, { remoteAddress: "127.0.0.1" }),
    ).toEqual({ chaos: true, reset: false });
    const live = ConfigSchema.parse({
      DEMO_MODE: "false",
      CHAOS_SECRET: SECRET,
    });
    expect(
      await probe(live, reset, { remoteAddress: "127.0.0.1", secret: SECRET }),
    ).toEqual({ chaos: false, reset: false });
  });
});
