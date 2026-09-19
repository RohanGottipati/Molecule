import { ProductIntentSchema } from "@molecule/contracts";
import { expect, it } from "vitest";
import { MockRealityClient } from "./MockRealityClient.js";

it("excludes persisted outages for new requests and restores suppliers after reset", async () => {
  const offline = new Set<string>();
  const reality = new MockRealityClient(() => offline);
  const intent = ProductIntentSchema.parse({
    intentId: "9e0c7b1a-0000-4000-8000-000000000200",
    version: 1,
    quantity: 200,
    deadline: "2026-09-25T23:59:59.000Z",
    currency: "CAD",
    transformations: [],
    hardConstraints: [],
    softPreferences: [],
    desiredOutputs: [
      {
        outputId: "hoodie",
        name: "Hoodie",
        quantity: 200,
        attributes: { product: "hoodie" },
      },
    ],
  });
  const merchants = async (excluded: string[] = []) =>
    (await reality.searchCandidates(intent, excluded)).map(
      (candidate) => candidate.merchantId,
    );
  expect(await merchants()).toContain("base-goods");
  offline.add("base-goods");
  expect(await merchants()).not.toContain("base-goods");
  expect(await merchants(["base-goods-2"])).toEqual([]);
  offline.clear();
  expect(await merchants()).toContain("base-goods");
});
