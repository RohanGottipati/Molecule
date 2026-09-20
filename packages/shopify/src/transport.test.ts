import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { checkoutUrl, shopDomain, ShopifyTransport } from "./transport.js";

const schema = z.object({ ok: z.boolean() });
const transport = (fetch: typeof globalThis.fetch, options = {}) =>
  new ShopifyTransport({
    domain: "molecule.myshopify.com",
    auth: { accessToken: "shpat_test" },
    fetch,
    ...options,
  });

describe("bounded Shopify transport", () => {
  it.each([
    "localhost",
    "https://x.myshopify.com",
    "x.myshopify.com.evil.test",
    "x.myshopify.com/path",
    "x.myshopify.com:443",
    "x@y.myshopify.com",
  ])("rejects an unsafe domain %s", (domain) => {
    expect(() => shopDomain(domain)).toThrow("INVALID_SHOP_DOMAIN");
  });
  it("only returns HTTPS checkout URLs on explicitly allowed domains", () => {
    expect(
      checkoutUrl(
        "https://molecule.myshopify.com/invoice",
        "molecule.myshopify.com",
      ),
    ).toContain("/invoice");
    for (const url of [
      "http://molecule.myshopify.com/",
      "https://evil.test/",
      "https://user:pass@molecule.myshopify.com/",
      "https://molecule.myshopify.com:8080/",
    ]) {
      expect(() => checkoutUrl(url, "molecule.myshopify.com")).toThrow(
        "UNSAFE_CHECKOUT_URL",
      );
    }
  });
  it.each([401, 403, 408, 429, 500, 502])(
    "sanitizes HTTP %i without blindly retrying mutations",
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response("token and private response", { status }),
        );
      await expect(
        transport(fetch, { maxThrottleRetries: 0 }).graphql(
          "mutation",
          {},
          schema,
          true,
        ),
      ).rejects.toMatchObject({
        code: status === 429 ? "THROTTLED" : `HTTP_${status}`,
        uncertain: status >= 500 || status === 408,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("retries a bounded explicit throttle and pins version/redirect policy", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(Response.json({ data: { ok: true } }));
    expect(
      await transport(fetch).graphql("mutation", {}, schema, true),
    ).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://molecule.myshopify.com/admin/api/2026-07/graphql.json",
    );
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("does not retry mixed GraphQL throttle/partial mutation responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        data: { ok: true },
        errors: [{ extensions: { code: "THROTTLED" } }],
      }),
    );
    await expect(
      transport(fetch).graphql("mutation", {}, schema, true),
    ).rejects.toMatchObject({ code: "GRAPHQL_ERROR", uncertain: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("enforces wall time even if fetch ignores AbortSignal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    await expect(
      transport(fetch, { timeoutMs: 15 }).graphql("mutation", {}, schema, true),
    ).rejects.toMatchObject({ code: "TIMEOUT", uncertain: true });
  });
  it("rejects malformed JSON, schema mismatch and API fall-forward", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("invalid"))
      .mockResolvedValueOnce(Response.json({ data: { notOk: true } }))
      .mockResolvedValueOnce(
        Response.json(
          { data: { ok: true } },
          { headers: { "x-shopify-api-version": "2026-10" } },
        ),
      );
    await expect(
      transport(fetch).graphql("mutation", {}, schema, true),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", uncertain: true });
    await expect(
      transport(fetch).graphql("mutation", {}, schema, true),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", uncertain: true });
    await expect(
      transport(fetch).graphql("mutation", {}, schema, true),
    ).rejects.toMatchObject({ code: "API_VERSION_MISMATCH", uncertain: true });
  });
  it("invalidates a rejected cached token for an explicit retry without replaying a mutation", async () => {
    let issued = 0;
    let revoked = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).includes("oauth")) {
        issued++;
        return Response.json({
          access_token: `test-token-${issued}`,
          expires_in: 86399,
        });
      }
      const token = new Headers(init?.headers).get("x-shopify-access-token");
      return revoked && token === "test-token-1"
        ? new Response("private auth failure", { status: 401 })
        : Response.json({ data: { ok: true } });
    });
    const client = transport(fetch, {
      auth: { clientId: "test-client", clientSecret: "test-secret" },
    });
    await client.graphql("query", {}, schema);
    revoked = true;
    await expect(
      client.graphql("mutation", {}, schema, true),
    ).rejects.toMatchObject({
      code: "HTTP_401",
      uncertain: false,
    });
    expect(
      fetch.mock.calls.filter(([, init]) =>
        String(init?.body).includes('"mutation"'),
      ),
    ).toHaveLength(1);
    await expect(client.graphql("mutation", {}, schema, true)).resolves.toEqual(
      { ok: true },
    );
    expect(issued).toBe(2);
  });

  it("refreshes expiring credentials once for concurrent requests", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(0);
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
        String(url).includes("oauth")
          ? Response.json({ access_token: "test-token", expires_in: 120 })
          : Response.json({ data: { ok: true } }),
      );
      const client = transport(fetch, {
        auth: { clientId: "test-client", clientSecret: "test-secret" },
      });
      await client.graphql("query", {}, schema);
      now.mockReturnValue(61_000);
      await Promise.all(
        Array.from({ length: 5 }, () => client.graphql("query", {}, schema)),
      );
      expect(
        fetch.mock.calls.filter(([url]) => String(url).includes("oauth")),
      ).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { accessToken: "" },
    { accessToken: " " },
    { clientId: "", clientSecret: "test" },
    { clientId: "test", clientSecret: "" },
  ])("rejects missing authentication before network access: %j", (auth) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => transport(fetch, { auth })).toThrow(
      "INVALID_TRANSPORT_CONFIG",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not journal a token grant failure as an uncertain commerce mutation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("private auth failure", { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: "test-token", expires_in: 86399 }),
      )
      .mockResolvedValueOnce(Response.json({ data: { ok: true } }));
    const client = transport(fetch, {
      auth: { clientId: "test-client", clientSecret: "test-secret" },
    });
    await expect(
      client.graphql("mutation", {}, schema, true),
    ).rejects.toMatchObject({
      code: "AUTH_HTTP_401",
      uncertain: false,
    });
    await expect(client.graphql("mutation", {}, schema, true)).resolves.toEqual(
      { ok: true },
    );
    expect(
      fetch.mock.calls.filter(([url]) => String(url).includes("graphql")),
    ).toHaveLength(1);
  });

  it("uses documented form-encoded client credentials and caches one concurrent refresh", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).includes("oauth")
        ? Response.json({ access_token: "short_lived_test", expires_in: 86399 })
        : Response.json({ data: { ok: true } }),
    );
    const client = transport(fetch, {
      auth: { clientId: "test-client", clientSecret: "test-secret" },
    });
    await Promise.all([
      client.graphql("query", {}, schema),
      client.graphql("query", {}, schema),
    ]);
    expect(
      fetch.mock.calls.filter(([url]) => String(url).includes("oauth")),
    ).toHaveLength(1);
    const init = fetch.mock.calls[0]?.[1];
    expect(String(init?.body)).toContain("grant_type=client_credentials");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it.each(["CAPACITY", null, ""])(
    "builds a capacity snapshot with SKU %j and preserves variant identity",
    async (sku) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const body = String(init?.body);
        if (body.includes("query Inventory")) {
          return Response.json({
            data: {
              inventoryItem: {
                id: "gid://shopify/InventoryItem/99",
                tracked: true,
                inventoryLevels: {
                  nodes: [
                    {
                      location: {
                        id: "gid://shopify/Location/1",
                        name: "Main",
                      },
                      quantities: [{ name: "available", quantity: 20 }],
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        }
        return Response.json({
          data: {
            products: {
              nodes: [
                {
                  id: "gid://shopify/Product/1",
                  title: "Embroidery capacity",
                  handle: "stitchworks-capacity",
                  status: "ACTIVE",
                  vendor: "StitchWorks",
                  productType: "Capacity",
                  tags: ["capacity"],
                  variants: {
                    nodes: [
                      {
                        id: "gid://shopify/ProductVariant/1",
                        sku,
                        price: "0.00",
                        selectedOptions: [],
                        inventoryItem: {
                          id: "gid://shopify/InventoryItem/99",
                          tracked: true,
                        },
                      },
                      {
                        id: "gid://shopify/ProductVariant/2",
                        sku: "",
                        price: "1.00",
                        selectedOptions: [],
                        inventoryItem: {
                          id: "gid://shopify/InventoryItem/100",
                          tracked: false,
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      });

      const snapshot = await transport(fetch).getSnapshot("stitchworks-test");

      expect(
        snapshot.products[0]?.variants.map(({ variantId, sku }) => ({
          variantId,
          sku,
        })),
      ).toEqual([
        { variantId: "gid://shopify/ProductVariant/1", sku: sku ?? "" },
        { variantId: "gid://shopify/ProductVariant/2", sku: "" },
      ]);
      expect(snapshot.capacity).toEqual([
        {
          shop: "stitchworks-test",
          role: "stitchworks",
          itemId: "gid://shopify/InventoryItem/99",
          title: "Embroidery capacity",
          quantity: 20,
        },
      ]);
    },
  );

  it("collects later variant and inventory-location pages and rejects repeated cursors", async () => {
    const variant = (id: number) => ({
      id: `gid://shopify/ProductVariant/${id}`,
      sku: `SKU-${id}`,
      price: "1.00",
      selectedOptions: [],
      inventoryItem: { id: `gid://shopify/InventoryItem/${id}`, tracked: true },
    });
    let repeat = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes("query Inventory"))
        return Response.json({
          data: {
            inventoryItem: {
              id: variables.id,
              tracked: true,
              inventoryLevels: {
                nodes: [
                  {
                    updatedAt: "2026-09-19T12:00:00Z",
                    location: {
                      id: `gid://shopify/Location/${variables.after ? 2 : 1}`,
                      name: "Warehouse",
                    },
                    quantities: [
                      { name: "available", quantity: variables.after ? 7 : 3 },
                    ],
                  },
                ],
                pageInfo: {
                  hasNextPage: !variables.after || repeat,
                  endCursor: "location-page",
                },
              },
            },
          },
        });
      if (query.includes("query Variants"))
        return Response.json({
          data: {
            product: {
              variants: {
                nodes: [variant(2)],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      return Response.json({
        data: {
          products: {
            nodes: [
              {
                id: "gid://shopify/Product/1",
                title: "Capacity",
                handle: "capacity",
                status: "ACTIVE",
                tags: ["capacity"],
                variants: {
                  nodes: [variant(1)],
                  pageInfo: { hasNextPage: true, endCursor: "variant-page" },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    });
    const client = transport(fetch);
    const snapshot = await client.getSnapshot();
    expect(snapshot.products[0]!.variants.map((v) => v.sku)).toEqual([
      "SKU-1",
      "SKU-2",
    ]);
    expect(snapshot.capacity.map((c) => c.quantity)).toEqual([10, 10]);
    const inventory = await client.getInventory(
      "gid://shopify/InventoryItem/1",
    );
    expect(
      inventory.inventoryItem?.inventoryLevels.nodes.map((n) => n.location.id),
    ).toHaveLength(2);
    repeat = true;
    await expect(
      client.getInventory("gid://shopify/InventoryItem/1"),
    ).rejects.toMatchObject({ code: "CATALOG_PAGINATION_REQUIRED" });
  });
});
