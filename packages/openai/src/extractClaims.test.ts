import { describe, expect, it } from "vitest";

import { MockOpenAIAdapter } from "./MockOpenAIAdapter.js";

describe("claim extraction handoff", () => {
  it("returns candidates but never canonical claims", async () => {
    const result = await new MockOpenAIAdapter().extractClaims({
      traceId: "trace-1",
      merchantId: "merchant-1",
      text: "Capacity is 1,200. Lead time is 3 days.",
      assets: [],
      locale: "en-CA",
    });
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "capacity.available", value: 1200 }),
        expect.objectContaining({ field: "leadTime.max", value: 3 }),
      ]),
    );
    expect(result).not.toHaveProperty("claims");
  });
});
