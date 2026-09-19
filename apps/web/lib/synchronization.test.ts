import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversationEntries,
  createReadQueue,
  reconcileAction,
  resumeCreatedAction,
  safeCapabilities,
} from "./synchronization";
import {
  capabilities,
  history,
  pending,
  snapshot,
  status,
} from "./workspace.fixtures";

afterEach(() => {
  vi.useRealTimers();
});

describe("authoritative operation reconciliation", () => {
  it("never infers a message result from a newer project and keeps exact retry payload", () => {
    const advanced = {
      ...snapshot,
      revision: 90,
      intentVersion: 20,
      planGeneration: 30,
    };
    const reconciled = reconcileAction(pending, {
      ...status,
      resultRevision: advanced.revision,
    });
    expect(reconciled.status).toBe("unknown");
    expect(reconciled.payload).toBe(pending.payload);
    expect(reconciled.key).toBe(pending.key);
    expect(conversationEntries([], reconciled)[0]?.status).toBe("unconfirmed");
  });
  it.each([
    { key: "another" },
    { orderId: "another" },
    { kind: "approve" as const },
  ])("rejects mismatched status identity %j", (change) => {
    expect(
      reconcileAction(pending, { ...status, status: "succeeded", ...change }),
    ).toBe(pending);
  });
  it("does not let an older in-flight status read overwrite an acknowledged terminal outcome", () => {
    const succeeded = { ...pending, status: "succeeded" as const };
    expect(reconcileAction(succeeded, status)).toBe(succeeded);
    expect(reconcileAction(succeeded, { ...status, status: "pending" })).toBe(
      succeeded,
    );
  });
  it("uses durable outcomes without inventing legacy or typed-action transcript text", () => {
    expect(conversationEntries([], null)).toEqual([]);
    expect(
      conversationEntries([], { ...pending, kind: "desktop", payload: null }),
    ).toEqual([]);
    expect(conversationEntries(history.messages, pending)).toHaveLength(1);
    expect(conversationEntries(history.messages, pending)[0]?.status).toBe(
      "unconfirmed",
    );
    const completed = history.messages.map((entry) => ({
      ...entry,
      outcome: {
        ...entry.outcome,
        status: "succeeded" as const,
        resultRevision: 10,
      },
    }));
    expect(conversationEntries(completed, pending)[0]).toMatchObject({
      status: "confirmed",
      source: "web",
    });
  });
  it("preserves the original message precondition after a lost create response and later project advance", () => {
    const create = {
      ...pending,
      kind: "create" as const,
      key: "create:one",
      orderId: null,
    };
    const first = resumeCreatedAction(create, snapshot, null);
    const reloaded = resumeCreatedAction(
      create,
      { ...snapshot, revision: 90 },
      first,
    );
    expect(reloaded).toBe(first);
    expect(reloaded.payload?.expectedRevision).toBe(8);
    expect(reloaded.key).toBe("message:create:one");
    expect(reloaded.payload?.text).toBe(pending.payload?.text);
    expect(
      resumeCreatedAction(
        { ...create, payload: first.payload },
        { ...snapshot, revision: 90 },
        null,
      ).payload?.expectedRevision,
    ).toBe(8);
    expect(() =>
      resumeCreatedAction(create, snapshot, {
        ...pending,
        key: "another-action",
      }),
    ).toThrow("resolve its pending action");
  });
});

describe("fresh guarded actions", () => {
  it("requires matching project/revision and disables all guarded actions on stale or uncertain reads", () => {
    expect(
      safeCapabilities(snapshot, capabilities, "fresh", []).canApprove,
    ).toBe(true);
    for (const freshness of ["idle", "loading", "refreshing", "stale"] as const)
      expect(
        safeCapabilities(snapshot, capabilities, freshness, []),
      ).toMatchObject({
        canApprove: false,
        canSubmitMessage: false,
        canCancelPlanning: false,
      });
    for (const read of [
      null,
      { ...capabilities, revision: 7 },
      { ...capabilities, orderId: "other" },
    ])
      expect(safeCapabilities(snapshot, read, "fresh", []).canApprove).toBe(
        false,
      );
    expect(
      safeCapabilities(snapshot, capabilities, "fresh", [], true).canApprove,
    ).toBe(false);
    expect(
      safeCapabilities(null, capabilities, "fresh", []).canSubmitMessage,
    ).toBe(false);
  });
  it("blocks approval for newly attached or modified context until compilation", () => {
    const asset = { assetId: "logo", checksum: "v2" };
    expect(
      safeCapabilities(snapshot, capabilities, "fresh", [asset]),
    ).toMatchObject({
      canApprove: false,
      canSubmitMessage: true,
      hasUncompiledContexts: true,
    });
    const compiled = {
      ...snapshot,
      intent: { ...snapshot.intent!, assets: [asset] },
    };
    expect(
      safeCapabilities(compiled, capabilities, "fresh", [asset]).canApprove,
    ).toBe(true);
    expect(
      safeCapabilities(compiled, capabilities, "fresh", [
        { ...asset, checksum: "v3" },
      ]).canApprove,
    ).toBe(false);
  });
  it("cannot cancel or edit after execution evidence even if the read grants permission", () => {
    const execution = {
      ...snapshot,
      state: "NEEDS_HUMAN" as const,
      lastErrorCode: "EXECUTION_UNCERTAIN",
    };
    expect(
      safeCapabilities(execution, capabilities, "fresh", []),
    ).toMatchObject({
      canApprove: false,
      canSubmitMessage: false,
      canCancelPlanning: false,
    });
  });
});

describe("bounded read scheduling", () => {
  it("coalesces event bursts without starving refresh and queues one rerun during active reads", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = createReadQueue(read, vi.fn());
    for (let count = 0; count < 100; count++) queue.request();
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledOnce();
    for (let count = 0; count < 100; count++) queue.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(2);
    queue.stop();
  });
  it("retries a final failed read with no further SSE frames and stops after recovery", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const queue = createReadQueue(read, onError);
    await queue.flush();
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    queue.stop();
  });
  it("never retries a retired project", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new Error("offline"));
    const queue = createReadQueue(read, vi.fn());
    await queue.flush();
    queue.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledOnce();
  });
});
