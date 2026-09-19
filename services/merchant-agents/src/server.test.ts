import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { MerchantQuoteUnavailableError, QuoteProtocolError } from "./quote.js";
import { createMerchantAgentsServer } from "./server.js";

async function withServer(
  quoteService: {
    handleQuoteRequest: (input: unknown) => Promise<unknown>;
  },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createMerchantAgentsServer({ quoteService });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function withMemoryServer(
  memoryService: {
    listMerchantMemory: (merchantId: string) => Promise<unknown>;
  },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const quoteService = {
    handleQuoteRequest: async () => ({}),
  };
  const server = createMerchantAgentsServer({ quoteService, memoryService });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const validRequest = {
  orderId: "order-1",
  traceId: "trace-1",
  capabilityId: "embroidery",
  quantity: 10,
  currency: "CAD",
};

describe("createMerchantAgentsServer", () => {
  it("serves POST /api/merchant-agents/:merchantId/quote and returns the quote service's response", async () => {
    let received: unknown;
    const quoteService = {
      handleQuoteRequest: async (input: unknown) => {
        received = input;
        return { status: "CAN_ACCEPT", merchantId: "stitchworks" };
      },
    };

    await withServer(quoteService, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/merchant-agents/stitchworks/quote`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(validRequest),
        },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "CAN_ACCEPT", merchantId: "stitchworks" });
    });

    expect(received).toMatchObject({
      ...validRequest,
      merchantId: "stitchworks",
    });
  });

  it("forces the URL's merchantId even if the request body names a different one", async () => {
    let received: unknown;
    const quoteService = {
      handleQuoteRequest: async (input: unknown) => {
        received = input;
        return { status: "CAN_ACCEPT" };
      },
    };

    await withServer(quoteService, async (baseUrl) => {
      await fetch(`${baseUrl}/api/merchant-agents/stitchworks/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validRequest, merchantId: "someone-else" }),
      });
    });

    expect(received).toMatchObject({ merchantId: "stitchworks" });
  });

  it("returns 404 for a non-quote route or non-POST method", async () => {
    const quoteService = { handleQuoteRequest: async () => ({}) };

    await withServer(quoteService, async (baseUrl) => {
      const wrongMethod = await fetch(
        `${baseUrl}/api/merchant-agents/stitchworks/quote`,
        { method: "GET" },
      );
      expect(wrongMethod.status).toBe(404);

      const wrongPath = await fetch(
        `${baseUrl}/api/merchant-agents/stitchworks`,
        {
          method: "POST",
        },
      );
      expect(wrongPath.status).toBe(404);
    });
  });

  it("returns 400 for a body that is not valid JSON", async () => {
    const quoteService = { handleQuoteRequest: async () => ({}) };

    await withServer(quoteService, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/merchant-agents/stitchworks/quote`,
        { method: "POST", body: "{not json" },
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_json");
    });
  });

  it("returns 400 when the quote service rejects the request with a ZodError", async () => {
    const quoteService = {
      handleQuoteRequest: async () => {
        const { QuoteRequestSchema } = await import("@molecule/contracts");
        QuoteRequestSchema.parse({});
        return {};
      },
    };

    await withServer(quoteService, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/merchant-agents/stitchworks/quote`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_request");
    });
  });

  it("returns 504 when the quote service reports a merchant as unavailable", async () => {
    const quoteService = {
      handleQuoteRequest: async () => {
        throw new MerchantQuoteUnavailableError("stitchworks", "TIMEOUT");
      },
    };

    await withServer(quoteService, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/merchant-agents/stitchworks/quote`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(validRequest),
        },
      );
      expect(response.status).toBe(504);
      const body = (await response.json()) as { error: string; reason: string };
      expect(body.error).toBe("merchant_unavailable");
      expect(body.reason).toBe("TIMEOUT");
    });
  });

  it("returns 502 when the quote service cannot validate the merchant's output", async () => {
    const quoteService = {
      handleQuoteRequest: async () => {
        throw new QuoteProtocolError("malformed twice", "stitchworks");
      },
    };

    await withServer(quoteService, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/merchant-agents/stitchworks/quote`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(validRequest),
        },
      );
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("quote_protocol_error");
    });
  });
});

describe("createMerchantAgentsServer memory route", () => {
  it("serves GET /api/merchant-agents/:merchantId/memory with the sanitized entries", async () => {
    let received: string | undefined;
    const entries = [
      {
        merchantId: "stitchworks",
        memoryId: "mem-1",
        note: "Never auto-accept rush embroidery above 40 units while machine #2 is down.",
        sourceThreadId: "thread-a",
        recordedAt: "2026-01-15T00:00:00.000Z",
      },
    ];
    const memoryService = {
      listMerchantMemory: async (merchantId: string) => {
        received = merchantId;
        return entries;
      },
    };

    await withMemoryServer(memoryService, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/merchant-agents/stitchworks/memory`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        merchantId: string;
        entries: unknown[];
      };
      expect(body.merchantId).toBe("stitchworks");
      expect(body.entries).toEqual(entries);
    });
    expect(received).toBe("stitchworks");
  });

  it("returns 404 for the memory route when no memory service is wired", async () => {
    const quoteService = { handleQuoteRequest: async () => ({}) };

    await withServer(quoteService, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/merchant-agents/stitchworks/memory`,
      );
      expect(response.status).toBe(404);
    });
  });

  it("returns 404 for a POST to the memory route", async () => {
    const memoryService = {
      listMerchantMemory: async () => [],
    };

    await withMemoryServer(memoryService, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/merchant-agents/stitchworks/memory`,
        { method: "POST" },
      );
      expect(response.status).toBe(404);
    });
  });
});
