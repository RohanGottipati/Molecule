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
});
