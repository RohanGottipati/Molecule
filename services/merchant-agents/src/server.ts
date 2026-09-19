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

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
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
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

export interface MerchantAgentsServerDeps {
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
  return createServer((req, res) => {
    void handleRequest(req, res, deps);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MerchantAgentsServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

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
    const body = await readJsonBody(req);
    const request =
      typeof body === "object" && body !== null
        ? { ...(body as Record<string, unknown>), merchantId }
        : { merchantId };
    const response = await quoteService.handleQuoteRequest(request);
    sendJson(res, 200, response);
  } catch (error) {
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
