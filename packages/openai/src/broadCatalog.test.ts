import { describe, expect, it } from "vitest";
import { MockOpenAIAdapter } from "./MockOpenAIAdapter.js";
const base = {
  orderId: "broad",
  traceId: "broad",
  locale: "en-CA",
  timeZone: "UTC",
  requestedAt: "2026-09-19T12:00:00Z",
  assets: [{ assetId: "artwork", checksum: "fixture" }],
};
describe("broad compiler vocabulary", () => {
  it.each([
    ["hoodies embroidered", "hoodie", "embroidery"],
    ["totes screen printed", "tote", "screen_printing"],
    ["phone cases for iPhone 16 UV printed", "phone case", "uv_printing"],
    ["desk mats sublimated", "desk mat", "sublimation"],
    ["keycaps sublimated", "keycap", "sublimation"],
    ["picture frames engraved", "picture frame", "engraving"],
    ["cutting boards engraved", "cutting board", "engraving"],
    ["gym towels embroidered", "gym towel", "embroidery"],
    ["pet tags engraved", "pet tag", "engraving"],
    ["luggage tags engraved", "luggage tag", "engraving"],
    ["gift tins UV printed", "gift tin", "uv_printing"],
    ["organizers 3D printed", "organizer", "3d_printing"],
  ])(
    "preserves product and operation: %s",
    async (phrase, product, operation) => {
      const result = await new MockOpenAIAdapter().compileIntent({
        ...base,
        text: `Make 10 ${phrase} by 2026-10-19 CAD under 2000.`,
      });
      expect(result.status, JSON.stringify(result)).toBe("READY");
      if (result.status !== "READY") return;
      expect(
        result.intent.desiredOutputs.some(
          (output) => output.attributes.product === product,
        ),
      ).toBe(true);
      expect(result.intent.transformations.map((t) => t.kind)).toEqual([
        operation,
      ]);
      expect(result.intent.assets).toEqual(base.assets);
    },
  );
  it("asks which device to fit instead of choosing one", async () => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "Make 10 phone cases UV printed by 2026-10-19 CAD.",
    });
    expect(result.status).toBe("NEEDS_CLARIFICATION");
  });
});
