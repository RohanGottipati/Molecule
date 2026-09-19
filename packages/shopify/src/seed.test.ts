import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeShopify, TestRepository } from "../tests/helpers.js";
import { seedCatalogProduct } from "./seed.js";
import { ShopifyTransport } from "./transport.js";

const product = {
  title: "Synthetic hoodie",
  handle: "synthetic-hoodie",
  vendor: "Synthetic",
  type: "Hoodies",
  descriptionHtml: "<p>Synthetic demonstration data</p>",
  tags: ["MOLECULE_DEMO"],
  variants: [
    {
      optionValues: [{ optionName: "Title", name: "Default Title" }],
      price: "12.00",
      sku: "DEMO",
      tracked: true,
      quantity: 1000,
    },
  ],
};
function options(provider: FakeShopify, repository = new TestRepository()) {
  return {
    transport: new ShopifyTransport(provider.options().centralStore),
    repository,
    product,
    traceId: "seed-test",
    executionEnabled: true,
  };
}

describe("authorized synthetic catalog seeding", () => {
  it("requires explicit authorization and a synthetic label before provider requests", async () => {
    const provider = new FakeShopify();
    await expect(
      seedCatalogProduct({ ...options(provider), executionEnabled: false }),
    ).rejects.toThrow("SEED_EXECUTION_DISABLED");
    await expect(
      seedCatalogProduct({
        ...options(provider),
        product: { ...product, tags: [] },
      }),
    ).rejects.toThrow("SYNTHETIC_LABEL_REQUIRED");
    expect(provider.calls).toHaveLength(0);
  });
  it("serializes concurrent seed retries with durable actions and events", async () => {
    const provider = new FakeShopify();
    const config = options(provider);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => seedCatalogProduct(config)),
    );
    expect(new Set(results.map((item) => item.id)).size).toBe(1);
    expect(results.filter((item) => !item.reused)).toHaveLength(1);
    expect(
      provider.calls.filter((call) => call.operation === "SeedProduct"),
    ).toHaveLength(1);
    expect(
      (await config.repository.events()).map((event) => event.eventType),
    ).toEqual(["shopify.seed.pending", "shopify.seed.succeeded"]);
  });
  it("reconciles a lost mutation response without replay and refuses unknown results", async () => {
    const provider = new FakeShopify();
    provider.fail = (operation) =>
      operation === "SeedProduct" ? "lost-response" : undefined;
    const config = options(provider);
    await expect(seedCatalogProduct(config)).rejects.toThrow("NETWORK_ERROR");
    provider.hideRecovery = true;
    await expect(seedCatalogProduct(config)).rejects.toThrow(
      "SEED_OUTCOME_UNKNOWN",
    );
    provider.hideRecovery = false;
    expect(await seedCatalogProduct(config)).toMatchObject({
      reused: true,
      id: "gid://shopify/Product/1",
    });
    expect(
      provider.calls.filter((call) => call.operation === "SeedProduct"),
    ).toHaveLength(1);
  });
  it("does not overwrite an existing non-demo product or silently ignore catalog drift", async () => {
    const provider = new FakeShopify();
    const config = options(provider);
    await seedCatalogProduct(config);
    const resource = provider.products.get(
      "molecule.myshopify.com:synthetic-hoodie",
    )!;
    resource.tags = [];
    await expect(seedCatalogProduct(config)).rejects.toThrow(
      "SEED_CATALOG_DRIFT",
    );
    await expect(
      seedCatalogProduct({ ...config, repository: new TestRepository() }),
    ).rejects.toThrow("SEED_HANDLE_NOT_OWNED");
  });
});

it("keeps a deterministic release catalog with canonical IDs, conflicts and two backup suppliers", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { releaseCatalogFor, catalogFor, MERCHANT_IDS, STITCHWORKS_CAPACITY_EVIDENCE } from "./scripts/seed-data.mjs";
     console.log(JSON.stringify({ catalogs: Object.fromEntries(Object.values(MERCHANT_IDS).map(id => [id, releaseCatalogFor(id)])), conflicts: STITCHWORKS_CAPACITY_EVIDENCE, same: JSON.stringify(catalogFor("base-goods")) === JSON.stringify(catalogFor("basegoods")) }));`,
    ],
    { cwd: new URL("../../../", import.meta.url), encoding: "utf8" },
  );
  const Product = z.object({
    tags: z.array(z.string()),
    descriptionHtml: z.string(),
    variants: z.array(
      z.object({ price: z.string(), quantity: z.number().nullable() }),
    ),
  });
  const result = z
    .object({
      catalogs: z.record(z.string(), z.array(Product)),
      conflicts: z.array(
        z.object({ source: z.string(), unitsPerDay: z.number() }),
      ),
      same: z.boolean(),
    })
    .parse(JSON.parse(output));
  expect(result.same).toBe(true);
  expect(result.conflicts.map((entry) => entry.unitsPerDay)).toEqual([
    100, 50, 20,
  ]);
  for (const [id, products] of Object.entries(result.catalogs)) {
    for (const item of products) {
      expect(item.tags).toContain(`merchant:${id}`);
      expect(item.descriptionHtml).toContain("Synthetic");
    }
  }
  for (const id of ["thread-forge", "needle-north"])
    expect(result.catalogs[id]?.[0]?.tags).toContain("units_per_day:400");
  const price = (id: string, index = 0) =>
    Math.round(Number(result.catalogs[id]![index]!.variants[0]!.price) * 100);
  const total =
    200 *
      (price("base-goods") +
        price("base-goods", 1) +
        price("snack-box") +
        price("needle-north") +
        price("laser-lab") +
        price("pack-ship") +
        price("pack-ship", 1)) +
    price("laser-lab", 1);
  expect(total).toBe(649500);
});
