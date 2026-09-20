import { afterAll, describe, expect, it } from "vitest";

import { createRealityApp } from "./server.js";

const app = createRealityApp();
afterAll(() => app.close());

describe("Reality request validation", () => {
  it.each(["/api/reality/ingest", "/api/reality/resolve"])(
    "rejects absent and null bodies at %s",
    async (url) => {
      for (const payload of [undefined, "null"]) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/json" },
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().retryable).toBe(false);
      }
    },
  );

  it("preserves parser errors as client errors", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/reality/ingest",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().retryable).toBe(false);
  });

  it("rejects non-string claim identifiers without coercing source data", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/reality/ingest",
      payload: {
        traceId: "validation",
        claims: [
          { merchantId: 123, field: "capacity", sourceReference: "raw" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
