import {
  ApiErrorSchema,
  BriefClarificationResultSchema,
} from "@molecule/contracts";
import { MockOpenAIAdapter, MoleculeOpenAIError } from "@molecule/openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "./config.js";
import { LocalStore } from "./LocalStore.js";
import { MockMerchantAgentClient } from "./mocks/MockMerchantAgentClient.js";
import { MockRealityClient } from "./mocks/MockRealityClient.js";
import { MockShopifyClient } from "./mocks/MockShopifyClient.js";
import { buildServer } from "./server.js";
import { Orchestrator } from "./workflow/Orchestrator.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const store = new LocalStore();
  await store.load();
  const openai = new MockOpenAIAdapter();
  const deps = {
    sessions: store,
    events: store,
    contexts: store,
    openai,
    solver: { solve: vi.fn() },
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
  cleanup.push(() => app.close());
  return { app, openai };
}

const payload = {
  text: "Make hoodies with embroidered logo",
  locale: "en-CA",
  timeZone: "UTC",
  requestedAt: "2026-09-20T12:00:00.000Z",
  assets: [],
};

describe("POST /api/briefs/clarify", () => {
  it("returns structured questions with options for an unclear brief", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/briefs/clarify",
      payload,
    });
    expect(response.statusCode).toBe(200);
    const result = BriefClarificationResultSchema.parse(response.json());
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.questions.map((question) => question.field)).toEqual([
      "quantity",
      "deadline",
      "currency",
    ]);
    expect(
      result.questions.every((question) => question.options.length > 0),
    ).toBe(true);
  });

  it("returns CLEAR for a complete brief and rejects malformed input", async () => {
    const { app } = await fixture();
    const clear = await app.inject({
      method: "POST",
      url: "/api/briefs/clarify",
      payload: { ...payload, text: "Make 20 hoodies by 2026-10-01 CAD" },
    });
    expect(clear.json()).toEqual({ status: "CLEAR" });
    const bad = await app.inject({
      method: "POST",
      url: "/api/briefs/clarify",
      payload: { ...payload, text: "" },
    });
    expect(bad.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(bad.json()).code).toBe("VALIDATION_ERROR");
  });

  it("maps provider failures to the typed error contract", async () => {
    const { app, openai } = await fixture();
    vi.spyOn(openai, "clarifyBrief").mockRejectedValueOnce(
      new MoleculeOpenAIError("TIMEOUT", "private upstream details", true),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/briefs/clarify",
      headers: { "x-trace-id": "trace-clarify" },
      payload,
    });
    expect(response.statusCode).toBe(504);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({
      code: "PROVIDER_TIMEOUT",
      traceId: "trace-clarify",
      retryable: true,
    });
    expect(response.body).not.toContain("private upstream details");
  });
});
