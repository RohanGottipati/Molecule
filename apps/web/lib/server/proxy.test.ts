import { createServer, type Server } from "node:http";
import { MAX_CONTEXT_BYTES } from "@molecule/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxyRequest } from "./proxy";

let server: Server;
let backend = "";
const requests: {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const buffers: Buffer[] = [];
    for await (const chunk of request) buffers.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(buffers).toString(),
    });
    if (request.url?.endsWith("/events")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        'id: 17\nevent: molecule\ndata: {"eventType":"solver.valid"}\n\n',
      );
      return;
    }
    response.writeHead(request.url?.endsWith("/missing") ? 404 : 200, {
      "Content-Type": "application/json",
      "Set-Cookie": "provider-internal=value",
    });
    response.end(JSON.stringify({ received: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Local test server unavailable");
  backend = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function incoming(path: string, init: RequestInit = {}) {
  return new Request(`https://preview.example/api/${path}`, init);
}

describe("same-origin proxy with a real local upstream", () => {
  it("forwards safe action metadata but no browser credentials or provider cookies", async () => {
    const response = await proxyRequest(
      incoming("orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "https://preview.example",
          "x-action-key": "message:one",
          "x-trace-id": "trace-one",
          authorization: "private-test-auth",
          cookie: "private-test-cookie",
          "x-chaos-secret": "private-test-chaos",
        },
        body: "{}",
      }),
      ["orders"],
      backend,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    const upstream = requests.at(-1)!;
    expect(upstream.path).toBe("/api/orders");
    expect(upstream.body).toBe("{}");
    expect(upstream.headers["x-action-key"]).toBe("message:one");
    expect(upstream.headers["x-trace-id"]).toBe("trace-one");
    for (const header of [
      "authorization",
      "cookie",
      "origin",
      "x-chaos-secret",
    ])
      expect(upstream.headers[header]).toBeUndefined();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("supports trusted preview host forwarding while rejecting cross-site mutations", async () => {
    const accepted = await proxyRequest(
      new Request("http://localhost:3000/api/orders", {
        method: "POST",
        headers: {
          "x-forwarded-host": "preview.example",
          origin: "https://preview.example",
        },
        body: "{}",
      }),
      ["orders"],
      backend,
    );
    expect(accepted.status).toBe(200);
    const count = requests.length;
    expect(
      (
        await proxyRequest(
          incoming("orders", {
            method: "POST",
            headers: { origin: "https://attacker.example" },
            body: "{}",
          }),
          ["orders"],
          backend,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await proxyRequest(
          incoming("orders", {
            method: "POST",
            headers: { "sec-fetch-site": "cross-site" },
            body: "{}",
          }),
          ["orders"],
          backend,
        )
      ).status,
    ).toBe(403);
    expect(requests).toHaveLength(count);
  });
  it("rejects traversal and provider-secret routes without contacting upstream", async () => {
    const count = requests.length;
    for (const path of [
      ["orders", ".."],
      ["orders", "%2Fetc"],
      ["orders", "id", "realtime", "client-secret"],
      ["unlisted"],
    ]) {
      expect((await proxyRequest(incoming("test"), path, backend)).status).toBe(
        404,
      );
    }
    expect(
      (
        await proxyRequest(
          incoming("orders", { method: "DELETE" }),
          ["orders"],
          backend,
        )
      ).status,
    ).toBe(404);
    expect(requests).toHaveLength(count);
  });
  it("streams SSE immediately and preserves the replay cursor", async () => {
    const controller = new AbortController();
    const response = await proxyRequest(
      incoming("orders/project/events", {
        headers: { "Last-Event-ID": "16" },
        signal: controller.signal,
      }),
      ["orders", "project", "events"],
      backend,
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(requests.at(-1)?.headers["last-event-id"]).toBe("16");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "id: 17",
    );
    await reader.cancel();
    controller.abort();
  });
  it("preserves upstream failures instead of returning an empty successful read model", async () => {
    expect(
      (
        await proxyRequest(
          incoming("orders/missing"),
          ["orders", "missing"],
          backend,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await proxyRequest(
          incoming("marketplace"),
          ["marketplace"],
          "file:///invalid",
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await proxyRequest(
          incoming("marketplace"),
          ["marketplace"],
          "https://user:password@example.com",
        )
      ).status,
    ).toBe(503);
  });
  it("rejects oversized uploads before forwarding their body", async () => {
    const count = requests.length;
    const response = await proxyRequest(
      incoming("projects/id/context", {
        method: "POST",
        headers: { "Content-Length": String(MAX_CONTEXT_BYTES + 1) },
        body: "x",
      }),
      ["projects", "id", "context"],
      backend,
    );
    expect(response.status).toBe(413);
    expect(requests).toHaveLength(count);
  });
  it("enforces the upload cap even without a content-length header", async () => {
    const count = requests.length;
    const response = await proxyRequest(
      incoming("projects/id/context", {
        method: "POST",
        body: new ArrayBuffer(MAX_CONTEXT_BYTES + 1),
      }),
      ["projects", "id", "context"],
      backend,
    );
    expect(response.status).toBe(413);
    expect(requests).toHaveLength(count);
  });
});
