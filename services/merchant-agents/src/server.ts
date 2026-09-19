import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { ZodError } from "zod";

import type { MerchantMemoryService } from "./memory.js";
import {
  MerchantQuoteUnavailableError,
  QuoteProtocolError,
  type QuoteService,
} from "./quote.js";

const QUOTE_ROUTE = /^\/api\/merchant-agents\/([^/]+)\/quote$/;
const MEMORY_ROUTE = /^\/api\/merchant-agents\/([^/]+)\/memory$/;

class BodyLimitError extends Error {}
class RequestTimeoutError extends Error {}

function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(
      () => reject(new RequestTimeoutError()),
      timeoutMs,
    );
    const cleanup = () => clearTimeout(timer);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        cleanup();
        chunks.length = 0;
        reject(new BodyLimitError());
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      cleanup();
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new SyntaxError("Request body is not valid JSON"));
      }
    });
    req.on("error", (error) => {
      cleanup();
      reject(error);
    });
    req.on("aborted", () => {
      cleanup();
      reject(new RequestTimeoutError());
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

export interface MerchantAgentsServerDeps {
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  health?: () => Promise<unknown>;
  quoteService: QuoteService;
  /**
   * B5 item 72: optional so a caller that only needs the quote endpoint (as
   * every existing server.test.ts case does) isn't forced to wire memory.
   * Omitting it makes GET .../memory report not_found rather than 500.
   */
  memoryService?: MerchantMemoryService;
}

/**
 * B4 item 67: POST /api/merchant-agents/:merchantId/quote. The path's
 * merchantId is authoritative — it overrides whatever merchantId the request
 * body carries, so a caller cannot quote one merchant while addressing
 * another's URL.
 *
 * B5 item 72: GET /api/merchant-agents/:merchantId/memory returns the
 * sanitized merchant-memory card data (fact + timestamp/source, never
 * reasoning) for that merchant.
 */
export function createMerchantAgentsServer(
  deps: MerchantAgentsServerDeps,
): Server {
  const server = createServer((req, res) => {
    const timer = setTimeout(
      () => sendJson(res, 408, { error: "request_timeout" }),
      deps.requestTimeoutMs ?? 30_000,
    );
    res.once("finish", () => clearTimeout(timer));
    res.once("close", () => clearTimeout(timer));
    void handleRequest(req, res, deps).catch((error: unknown) => {
      sendJson(
        res,
        error instanceof URIError || error instanceof TypeError ? 400 : 500,
        {
          error:
            error instanceof URIError || error instanceof TypeError
              ? "invalid_request"
              : "internal_error",
        },
      );
    });
  });
  server.requestTimeout = deps.requestTimeoutMs ?? 30_000;
  server.headersTimeout = Math.min(10_000, server.requestTimeout);
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MerchantAgentsServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health" && req.method === "GET") {
    try {
      sendJson(
        res,
        200,
        deps.health ? await deps.health() : { status: "ready" },
      );
    } catch {
      sendJson(res, 503, { status: "unavailable" });
    }
    return;
  }

  const memoryMatch = MEMORY_ROUTE.exec(url.pathname);
  if (memoryMatch && req.method === "GET") {
    if (!deps.memoryService) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const merchantId = decodeURIComponent(memoryMatch[1]!);
    try {
      const entries = await deps.memoryService.listMerchantMemory(merchantId);
      sendJson(res, 200, { merchantId, entries });
    } catch {
      sendJson(res, 500, { error: "internal_error" });
    }
    return;
  }

  const match = QUOTE_ROUTE.exec(url.pathname);
  if (!match || req.method !== "POST") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const quoteService = deps.quoteService;
  const merchantId = decodeURIComponent(match[1]!);

  try {
    const body = await readJsonBody(
      req,
      deps.maxBodyBytes ?? 256 * 1024,
      deps.requestTimeoutMs ?? 30_000,
    );
    const request =
      typeof body === "object" && body !== null
        ? { ...(body as Record<string, unknown>), merchantId }
        : { merchantId };
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.on("close", disconnect);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        quoteService.handleQuoteRequest(request, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new RequestTimeoutError());
          }, deps.requestTimeoutMs ?? 30_000);
        }),
      ]);
      sendJson(res, 200, response);
    } finally {
      clearTimeout(timer);
      res.off("close", disconnect);
    }
  } catch (error) {
    if (error instanceof BodyLimitError) {
      sendJson(res, 413, { error: "body_too_large" });
      return;
    }
    if (error instanceof RequestTimeoutError) {
      sendJson(res, 408, { error: "request_timeout" });
      return;
    }
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { error: "invalid_json", message: error.message });
      return;
    }
    if (error instanceof ZodError) {
      sendJson(res, 400, { error: "invalid_request", issues: error.issues });
      return;
    }
    if (error instanceof MerchantQuoteUnavailableError) {
      sendJson(res, 504, {
        error: "merchant_unavailable",
        merchantId: error.merchantId,
        reason: error.reason,
      });
      return;
    }
    if (error instanceof QuoteProtocolError) {
      sendJson(res, 502, {
        error: "quote_protocol_error",
        merchantId: error.merchantId,
        message: error.message,
      });
      return;
    }
    sendJson(res, 500, { error: "internal_error" });
  }
}
