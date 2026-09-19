import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPlanning,
  getActionStatus,
  getCapabilities,
  getMessages,
  getProjects,
  submitMessagePayload,
  uploadContext,
} from "./api";
import { readProject } from "./projectReadModel";
import {
  capabilities,
  history,
  pending,
  snapshot,
  status,
} from "./workspace.fixtures";

afterEach(() => vi.unstubAllGlobals());

describe("canonical durable read clients", () => {
  it("encodes project searches and cursors without treating them as navigation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ projects: [], nextCursor: "page-two" }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      getProjects({ search: "hoodies & bottles", cursor: "opaque+/=" }),
    ).resolves.toMatchObject({ nextCursor: "page-two" });
    const url = new URL(fetcher.mock.calls[0]![0], "https://example.test");
    expect(url.pathname).toBe("/api/projects");
    expect(url.searchParams.get("search")).toBe("hoodies & bottles");
    expect(url.searchParams.get("cursor")).toBe("opaque+/=");
    expect(url.searchParams.get("limit")).toBe("20");
  });
  it.each([
    { orderId: "another" },
    { key: "another" },
    { kind: "approve" },
    { automaticRetryAllowed: true },
  ])("rejects foreign or unsafe action status %j", async (change) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...status, ...change })),
    );
    await expect(
      getActionStatus(snapshot.orderId, { kind: "message", key: pending.key }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("rejects foreign capabilities and malformed history continuation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ...capabilities, orderId: "other" }),
      )
      .mockResolvedValueOnce(Response.json({ ...history, nextCursor: 0 }))
      .mockResolvedValueOnce(
        Response.json({
          ...history,
          messages: [{ ...history.messages[0], orderId: "other" }],
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(getCapabilities(snapshot.orderId)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(getMessages(snapshot.orderId)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(getMessages(snapshot.orderId)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("sends the identical stored message, assets and precondition on explicit retry", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(Response.json({ ...snapshot, revision: 90 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      submitMessagePayload(snapshot, pending.payload!, pending.key),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await submitMessagePayload(
      { ...snapshot, traceId: pending.traceId },
      pending.payload!,
      pending.key,
    );
    expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual(pending.payload);
    expect(fetcher.mock.calls[1]![1].headers["x-action-id"]).toBe(pending.key);
  });
  it("rejects duplicate or out-of-order durable messages before advancing a cursor", async () => {
    const original = history.messages[0];
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          messages: [original, { ...original, cursor: 2 }],
          nextCursor: 2,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          messages: [
            { ...original, cursor: 2 },
            { ...original, cursor: 1 },
          ],
          nextCursor: 1,
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(getMessages(snapshot.orderId)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(getMessages(snapshot.orderId)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("guards cancellation using persisted execution evidence and expected revision", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ...capabilities,
          capabilities: {
            ...capabilities.capabilities,
            canCancelPlanning: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ ...capabilities, revision: snapshot.revision + 1 }),
      )
      .mockResolvedValueOnce(Response.json(capabilities))
      .mockResolvedValueOnce(
        Response.json({
          project: { ...snapshot, state: "CANCELLED" },
          contexts: [],
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const beforeSubmit = vi.fn();
    await expect(
      cancelPlanning(snapshot, "cancel-one", beforeSubmit),
    ).rejects.toThrow("unavailable");
    await expect(
      cancelPlanning(snapshot, "cancel-one", beforeSubmit),
    ).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(beforeSubmit).not.toHaveBeenCalled();
    await cancelPlanning(snapshot, "cancel-one", beforeSubmit);
    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[3]![1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "x-action-id": "cancel-one" }),
    });
    expect(JSON.parse(fetcher.mock.calls[3]![1].body)).toMatchObject({
      actionId: "cancel-one",
      command: { name: "cancel_project", args: {} },
      expectedRevision: snapshot.revision,
    });
  });
  it("records the separate attach identity before an interrupted attachment response", async () => {
    const contextId = "aabbccdd-1234-4234-9234-123456789abc";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          contextId,
          asset: { assetId: contextId, checksum: "bytes" },
        }),
      )
      .mockRejectedValueOnce(new Error("lost attach response"));
    vi.stubGlobal("fetch", fetcher);
    const uploaded = vi.fn();
    await expect(
      uploadContext(
        snapshot,
        new File(["logo"], "logo.txt", { type: "text/plain" }),
        "upload-one",
        uploaded,
      ),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(uploaded).toHaveBeenCalledWith(contextId);
    expect(fetcher.mock.calls[1]![1].headers["x-action-id"]).toBe(
      `attach:${contextId}`,
    );
  });
});

describe("atomic project read bundles", () => {
  function backend(revision = snapshot.revision) {
    return vi.fn(async (path: string) => {
      if (path.includes("/capabilities"))
        return Response.json({ ...capabilities, revision });
      if (path.startsWith("/api/projects/"))
        return Response.json({
          project: snapshot,
          contexts: pending.payload!.assets,
        });
      if (path.includes("/messages?afterCursor=1"))
        return Response.json({
          messages: [
            {
              ...history.messages[0],
              messageId: "message:two",
              cursor: 2,
              outcome: {
                ...history.messages[0]!.outcome,
                messageId: "message:two",
              },
            },
          ],
          nextCursor: null,
        });
      if (path.includes("/messages?"))
        return Response.json({ ...history, nextCursor: 1 });
      return Response.json(snapshot);
    });
  }
  it("refreshes snapshots, attached contexts and loaded transcript pages together", async () => {
    const fetcher = backend();
    vi.stubGlobal("fetch", fetcher);
    const read = await readProject(snapshot.orderId, 2);
    expect(read.contexts).toEqual(pending.payload!.assets);
    expect(read.history.messages.map((entry) => entry.cursor)).toEqual([1, 2]);
    expect(read.history.nextCursor).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(5);
    await readProject(snapshot.orderId, 2);
    expect(
      fetcher.mock.calls.filter(([path]) => path.includes("afterCursor=0")),
    ).toHaveLength(2);
  });
  it("does not expose a partial fresh read when revisions disagree", async () => {
    vi.stubGlobal("fetch", backend(snapshot.revision - 1));
    await expect(readProject(snapshot.orderId)).rejects.toMatchObject({
      code: "STALE_VERSION",
    });
  });
  it("rejects old attachment lists even when the order and capability revisions match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path.includes("/projects/"))
          return Response.json({
            project: { ...snapshot, revision: snapshot.revision - 1 },
            contexts: [],
          });
        if (path.includes("/capabilities")) return Response.json(capabilities);
        if (path.includes("/messages")) return Response.json(history);
        return Response.json(snapshot);
      }),
    );
    await expect(readProject(snapshot.orderId)).rejects.toMatchObject({
      code: "STALE_VERSION",
    });
  });
  it("aborts sibling reads after one failure so quiet retries cannot accumulate requests", async () => {
    const aborted = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init: RequestInit) => {
        if (path.includes("/capabilities"))
          return Promise.resolve(
            Response.json({ message: "unavailable" }, { status: 503 }),
          );
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              aborted();
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      }),
    );
    await expect(readProject(snapshot.orderId)).rejects.toMatchObject({
      status: 503,
    });
    expect(aborted).toHaveBeenCalledTimes(3);
  });
});
