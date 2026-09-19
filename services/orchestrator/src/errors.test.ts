import { ApiErrorSchema } from "@molecule/contracts";
import { MockOpenAIAdapter, MoleculeOpenAIError } from "@molecule/openai";
import { describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "./config.js";
import { LocalStore } from "./LocalStore.js";
import { MockMerchantAgentClient } from "./mocks/MockMerchantAgentClient.js";
import { MockRealityClient } from "./mocks/MockRealityClient.js";
import { MockShopifyClient } from "./mocks/MockShopifyClient.js";
import { buildServer } from "./server.js";
import { Orchestrator } from "./workflow/Orchestrator.js";

describe("HTTP error contract", () => {
  it("returns typed, sanitized validation/provider/internal errors and missing projects", async () => {
    const store = new LocalStore();
    await store.load();
    const openai = new MockOpenAIAdapter();
    const solver = { solve: vi.fn() };
    const deps = {
      sessions: store,
      events: store,
      contexts: store,
      openai,
      solver,
      reality: new MockRealityClient(),
      merchantAgents: new MockMerchantAgentClient(),
      shopify: new MockShopifyClient(),
    };
    const app = await buildServer({
      ...deps,
      config: ConfigSchema.parse({}),
      orchestrator: new Orchestrator(deps),
      desktopStore: store,
    });
    try {
      const bad = await app.inject({
        method: "POST",
        url: "/api/intents/compile",
        payload: {},
      });
      expect(bad.statusCode).toBe(400);
      expect(ApiErrorSchema.parse(bad.json()).code).toBe("VALIDATION_ERROR");
      const missing = await app.inject({
        method: "GET",
        url: "/api/projects/missing",
      });
      expect(missing.statusCode).toBe(404);
      expect(ApiErrorSchema.parse(missing.json()).code).toBe("NOT_FOUND");
      for (const [error, status, code] of [
        [
          new MoleculeOpenAIError("AUTH", "private upstream details", false),
          502,
          "PROVIDER_AUTH",
        ],
        [
          new MoleculeOpenAIError(
            "RATE_LIMIT",
            "private upstream details",
            true,
          ),
          429,
          "RATE_LIMITED",
        ],
        [
          new MoleculeOpenAIError("TIMEOUT", "private upstream details", true),
          504,
          "PROVIDER_TIMEOUT",
        ],
        [new Error("private upstream details"), 500, "INTERNAL"],
      ] as const) {
        vi.spyOn(openai, "compileIntent").mockRejectedValueOnce(error);
        const response = await app.inject({
          method: "POST",
          url: "/api/intents/compile",
          headers: { "x-trace-id": "trace-acceptance" },
          payload: {
            orderId: "project",
            traceId: "trace-acceptance",
            text: "20 hoodies",
            locale: "en-CA",
            timeZone: "UTC",
            requestedAt: "2026-09-19T12:00:00.000Z",
            assets: [],
          },
        });
        expect(response.statusCode).toBe(status);
        expect(ApiErrorSchema.parse(response.json())).toMatchObject({
          code,
          traceId: "trace-acceptance",
        });
        expect(response.body).not.toContain("private upstream details");
      }
    } finally {
      await app.close();
    }
  });
});
