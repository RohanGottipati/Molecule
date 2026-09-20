import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";
import {
  configuredShopifyDomains,
  fakeShopifyConfiguration,
  liveShopifyConfiguration,
} from "./shopifyConfig.js";

const live = {
  STORAGE_MODE: "postgres",
  DATABASE_URL: "postgres://localhost/isolated_test",
  SHOPIFY_MODE: "live",
  REAL_EXECUTION_ENABLED: "true",
  SHOPIFY_CLIENT_ID: "synthetic-client",
  SHOPIFY_API_SECRET: "synthetic-secret",
  MOLECULE_STOREFRONT_DOMAIN: "molecule-storefront.myshopify.com",
  SHOPIFY_STORES:
    "molecule-storefront,basegoods-test,threadforge-test,printpress-test",
};

describe("live Shopify configuration", () => {
  it("uses existing app credentials and storefront alias without static access tokens", () => {
    const config = readConfig(live);
    const stores = liveShopifyConfiguration(config);
    expect(stores.centralStore).toEqual({
      domain: "molecule-storefront.myshopify.com",
      auth: { clientId: "synthetic-client", clientSecret: "synthetic-secret" },
    });
    expect(Object.keys(stores.supplierStores).sort()).toEqual([
      "base-goods",
      "thread-forge",
    ]);
    expect(stores.supplierStores["thread-forge"]).toEqual({
      domain: "threadforge-test.myshopify.com",
      auth: stores.centralStore.auth,
    });
    expect(stores.snapshotStores).toHaveLength(4);
  });

  it("retains explicit access-token configurations without requiring app credentials", () => {
    const config = readConfig({
      ...live,
      SHOPIFY_CLIENT_ID: "",
      SHOPIFY_API_SECRET: "",
      SHOPIFY_ACCESS_TOKEN: "synthetic-central-token",
      SHOPIFY_SUPPLIER_STORES: JSON.stringify({
        "base-goods": {
          domain: "basegoods-test.myshopify.com",
          auth: { accessToken: "synthetic-base-token" },
        },
        "thread-forge": {
          domain: "threadforge-test.myshopify.com",
          auth: { accessToken: "synthetic-thread-token" },
        },
      }),
    });
    expect(liveShopifyConfiguration(config).centralStore.auth).toEqual({
      accessToken: "synthetic-central-token",
    });
    expect(
      liveShopifyConfiguration(config).supplierStores["base-goods"]?.auth,
    ).toEqual({ accessToken: "synthetic-base-token" });
  });

  it("supports per-store app credentials and shared-auth explicit mappings", () => {
    const stores = liveShopifyConfiguration(
      readConfig({
        ...live,
        SHOPIFY_SUPPLIER_STORES: JSON.stringify({
          "base-goods": {
            domain: "basegoods-test",
            auth: { clientId: "other-client", clientSecret: "other-secret" },
          },
          "thread-forge": { domain: "threadforge-test" },
        }),
      }),
    );
    expect(stores.supplierStores["base-goods"]?.auth).toEqual({
      clientId: "other-client",
      clientSecret: "other-secret",
    });
    expect(stores.supplierStores["thread-forge"]?.auth).toEqual(
      stores.centralStore.auth,
    );
  });

  it("normalizes and deduplicates configured domains", () => {
    expect(
      configuredShopifyDomains(
        " BaseGoods-Test,basegoods-test.myshopify.com,, ",
      ),
    ).toEqual(["basegoods-test.myshopify.com"]);
  });

  it.each([
    { REAL_EXECUTION_ENABLED: "false" },
    { STORAGE_MODE: "local" },
    { DATABASE_URL: "" },
    { SHOPIFY_CLIENT_ID: "", SHOPIFY_ACCESS_TOKEN: "" },
    { SHOPIFY_STORES: "" },
    { SHOPIFY_STORES: "molecule-storefront,unknown-supplier" },
    { SHOPIFY_STORES: "basegoods-one,basegoods-two" },
    { SHOPIFY_STORES: "basegoods-test.myshopify.com.attacker.invalid" },
    { SHOPIFY_STOREFRONT_DOMAIN: "different-store.myshopify.com" },
    {
      SHOPIFY_SUPPLIER_STORES: JSON.stringify({
        "base-goods": {
          domain: "different-store",
          auth: { accessToken: "token" },
        },
      }),
    },
    {
      SHOPIFY_SUPPLIER_STORES: JSON.stringify({
        "base-goods": { domain: "molecule-storefront" },
      }),
    },
    {
      SHOPIFY_SUPPLIER_STORES: JSON.stringify({
        "base-goods": { domain: "basegoods-test" },
        other: { domain: "basegoods-test" },
      }),
    },
    {
      SHOPIFY_SUPPLIER_STORES: JSON.stringify({
        other: { domain: "basegoods-test" },
      }),
    },
    {
      SHOPIFY_SUPPLIER_STORES: JSON.stringify({
        "base-goods": {
          domain: "basegoods-test",
          auth: {
            accessToken: "token",
            clientId: "client",
            clientSecret: "secret",
          },
        },
      }),
    },
  ])("fails closed for invalid/ambiguous configuration: %j", (override) => {
    expect(() => readConfig({ ...live, ...override })).toThrow();
  });

  it("does not expose secrets in JSON or schema validation errors", () => {
    for (const value of [
      "sensitive-invalid-json",
      JSON.stringify({
        "base-goods": {
          domain: "basegoods-test",
          auth: { clientSecret: "sensitive-invalid-json" },
        },
      }),
    ]) {
      try {
        readConfig({ ...live, SHOPIFY_SUPPLIER_STORES: value });
        throw new Error("Expected invalid config");
      } catch (error) {
        expect(String(error)).toContain("Invalid live Shopify configuration");
        expect(String(error)).not.toContain("sensitive-invalid-json");
      }
    }
  });

  it("does not parse or enable live credentials in demo mode", () => {
    expect(
      readConfig({ SHOPIFY_MODE: "demo", SHOPIFY_SUPPLIER_STORES: "invalid" })
        .REAL_EXECUTION_ENABLED,
    ).toBe(false);
  });
});

describe("fake Shopify configuration", () => {
  const fake = {
    SHOPIFY_MODE: "fake",
    STORAGE_MODE: "postgres",
    DATABASE_URL: "postgres://localhost/molecule",
  };

  it("needs no credentials and never enables real execution", () => {
    const config = readConfig(fake);
    expect(config.SHOPIFY_MODE).toBe("fake");
    expect(config.REAL_EXECUTION_ENABLED).toBe(false);
  });

  it("refuses to run without the durable runtime", () => {
    expect(() =>
      readConfig({ SHOPIFY_MODE: "fake", STORAGE_MODE: "local" }),
    ).toThrow("SHOPIFY_MODE=fake requires STORAGE_MODE=postgres");
  });

  it("refuses to be combined with real execution", () => {
    expect(() =>
      readConfig({ ...fake, REAL_EXECUTION_ENABLED: "true" }),
    ).toThrow("cannot run with REAL_EXECUTION_ENABLED=true");
  });

  it("builds the same shape as the live configuration, with an injected fetch", () => {
    const config = readConfig(fake);
    const resolved = fakeShopifyConfiguration(config);

    expect(resolved.snapshotStores.length).toBeGreaterThan(1);
    expect(resolved.centralStore.domain).toMatch(/\.myshopify\.com$/);
    expect(resolved.centralStore.fetch).toBe(resolved.admin.fetch);
    expect(Object.keys(resolved.supplierStores).length).toBeGreaterThan(0);

    for (const store of Object.values(resolved.supplierStores)) {
      expect(store.domain).toMatch(/\.myshopify\.com$/);
      expect(store.fetch).toBe(resolved.admin.fetch);
      // The central storefront is never also a supplier.
      expect(store.domain).not.toBe(resolved.centralStore.domain);
    }
  });

  it("honours an explicit store list", () => {
    const resolved = fakeShopifyConfiguration(
      readConfig({
        ...fake,
        SHOPIFY_STORES: "basegoods-tyefhh8o,threadforge-eznglsyk",
      }),
    );
    expect(resolved.snapshotStores).toEqual([
      "basegoods-tyefhh8o.myshopify.com",
      "threadforge-eznglsyk.myshopify.com",
    ]);
  });
});
