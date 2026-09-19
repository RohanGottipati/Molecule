import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMerchantAgentsServer } from "./server.js";

let server: ReturnType<typeof createMerchantAgentsServer>;
async function start(timeout = 1000) {
  server = createMerchantAgentsServer({
    maxBodyBytes: 100,
    requestTimeoutMs: timeout,
    quoteService: { handleQuoteRequest: () => new Promise(() => {}) },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
describe("merchant HTTP bounds", () => {
  it("returns health and rejects oversized requests or malformed escaped merchant IDs", async () => {
    const base = await start();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(
      (
        await fetch(`${base}/api/merchant-agents/a/quote`, {
          method: "POST",
          body: "x".repeat(101),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fetch(`${base}/api/merchant-agents/%ZZ/quote`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });
  it("bounds an unresponsive quote service", async () => {
    const base = await start(30);
    expect(
      (
        await fetch(`${base}/api/merchant-agents/a/quote`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(408);
  });
});
