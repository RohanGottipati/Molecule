import {
  MAX_CONTEXT_BYTES,
  OrderSessionSnapshotSchema,
} from "@molecule/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvePlan,
  clarifyBrief,
  createOrder,
  fileMetadata,
  getDemoMode,
  getMarketplace,
  getOrder,
  request,
  RequestError,
  triggerChaos,
  uploadContext,
} from "./api";

const snapshot = OrderSessionSnapshotSchema.parse({
  orderId: "project-one",
  traceId: "trace-one",
  state: "REQUESTED",
  revision: 0,
  intentVersion: 0,
  planGeneration: 0,
  eventCursor: 0,
  intent: null,
  candidates: [],
  quotes: [],
  activePlan: null,
  executionReceipt: null,
  lastErrorCode: null,
  createdAt: "2026-09-19T10:00:00Z",
  updatedAt: "2026-09-19T10:00:00Z",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("canonical API responses", () => {
  it("creates only through an explicit same-origin call with action headers and a valid JSON body", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(snapshot));
    vi.stubGlobal("fetch", fetcher);
    await expect(createOrder("create:operation-one")).resolves.toEqual(
      snapshot,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/orders",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({
          "x-action-id": "create:operation-one",
          "x-action-key": "create:operation-one",
          "x-trace-id": "create:operation-one",
        }),
      }),
    );
  });
  it("rejects incompatible domain data rather than treating it as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => Response.json({ status: "ok" })),
    );
    await expect(getOrder("project-one")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(getMarketplace()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(getDemoMode()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("surfaces sanitized provider errors without swallowing failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: "PROVIDER_TIMEOUT",
            message: "Merchant quote timed out",
            traceId: "trace-one",
            retryable: true,
          },
          { status: 504 },
        ),
      ),
    );
    await expect(getOrder("project-one")).rejects.toMatchObject({
      status: 504,
      code: "PROVIDER_TIMEOUT",
      traceId: "trace-one",
    });
  });
  it("does not expose unstructured upstream error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("sensitive provider details", { status: 502 }),
        ),
    );
    await expect(request("/api/orders/project-one")).rejects.toThrow(
      "The service could not complete this request (502)",
    );
  });
  it("aborts long requests and keeps the outcome explicitly unknown", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    );
    const promise = request("/api/orders");
    const assertion = expect(promise).rejects.toMatchObject({
      code: "INTERRUPTED",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });
  it("never approves an absent or stale solver plan", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(approvePlan(snapshot)).rejects.toThrow("solver-validated");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses an explicit stable action identity for supplier recovery", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(snapshot));
    vi.stubGlobal("fetch", fetcher);
    await triggerChaos(
      snapshot,
      "thread-forge",
      "supplier_offline",
      "offline:project:plan:thread-forge",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/chaos",
      expect.objectContaining({
        body: JSON.stringify({
          scenario: "supplier_offline",
          orderId: snapshot.orderId,
          merchantId: "thread-forge",
          actionId: "offline:project:plan:thread-forge",
        }),
      }),
    );
  });
});

describe("brief clarification", () => {
  it("sends the brief with browser locale context and returns structured questions", async () => {
    const result = {
      status: "NEEDS_INPUT",
      questions: [
        {
          questionId: "quantity:1",
          field: "quantity",
          question: "How many units do you need?",
          options: [{ label: "50", value: "50" }],
        },
      ],
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetcher);
    const parsed = await clarifyBrief("Make hoodies");
    expect(parsed.status).toBe("NEEDS_INPUT");
    if (parsed.status !== "NEEDS_INPUT") return;
    expect(parsed.questions[0]).toMatchObject({
      questionId: "quantity:1",
      allowCustom: true,
      options: [{ label: "50", value: "50" }],
    });
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/briefs/clarify");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ text: "Make hoodies", assets: [] });
    expect(typeof body.requestedAt).toBe("string");
    expect(typeof body.timeZone).toBe("string");
    expect(body).not.toHaveProperty("orderId");
  });
  it("rejects malformed clarification results instead of advancing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ status: "NEEDS_INPUT" })),
    );
    await expect(clarifyBrief("Make hoodies")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});

describe("context upload", () => {
  it("rejects invalid MIME types, unsafe names, empty and oversized files", () => {
    for (const file of [
      new File(["x"], "logo.svg", { type: "image/svg+xml" }),
      new File(["x"], "../secret.txt", { type: "text/plain" }),
      new File([], "empty.txt", { type: "text/plain" }),
      new File([new Uint8Array(MAX_CONTEXT_BYTES + 1)], "large.txt", {
        type: "text/plain",
      }),
    ])
      expect(() => fileMetadata(file, "upload-one")).toThrow();
    expect(
      fileMetadata(new File(["names"], "names.csv"), "upload-one").mimeType,
    ).toBe("text/csv");
  });
  it("uploads bytes then attaches the validated receipt with a deterministic action ID", async () => {
    const id = "aabbccdd-1234-4234-9234-123456789abc";
    const asset = { assetId: id, name: "logo.png", checksum: "checksum" };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ contextId: id, asset }))
      .mockResolvedValueOnce(
        Response.json({ project: snapshot, contexts: [asset] }),
      );
    vi.stubGlobal("fetch", fetcher);
    const file = new File(["bytes"], "logo.png", { type: "image/png" });
    await expect(
      uploadContext(snapshot, file, "upload-one"),
    ).resolves.toMatchObject({ contexts: [asset] });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/projects/project-one/context",
      expect.objectContaining({
        body: file,
        headers: expect.objectContaining({
          "Content-Type": "application/octet-stream",
          "x-file-name": "logo.png",
          "x-action-id": "upload-one",
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/projects/project-one/actions",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-action-id": `attach:${id}` }),
      }),
    );
  });
  it("does not report attachment success if upload fails", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ message: "failed" }, { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      uploadContext(
        snapshot,
        new File(["x"], "name.txt", { type: "text/plain" }),
        "upload-one",
      ),
    ).rejects.toBeInstanceOf(RequestError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
