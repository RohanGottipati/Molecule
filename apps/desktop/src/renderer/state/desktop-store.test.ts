import { ProductionPlanSchema } from "@molecule/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopStore } from "./desktop-store.js";
import {
  backendEvent,
  mockBridge,
  projectResult,
} from "../services/test-fixtures.js";
import { subscribeEvents } from "../services/events.js";

vi.mock("../services/events.js", async (original) => ({
  ...(await original<typeof import("../services/events.js")>()),
  subscribeEvents: vi.fn(async () => undefined),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function fixture() {
  const bridge = mockBridge();
  const notify = vi.spyOn(bridge, "notify");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        demoMode: true,
        mockProviders: { openai: true },
        maxContextBytes: 10_485_760,
      }),
    ),
  );
  const store = new DesktopStore(bridge);
  await store.initialize();
  return { store, bridge, notify };
}
describe("authoritative desktop state", () => {
  it("does not reopen an event stream when a connection check resolves after disposal", async () => {
    const { store } = await fixture();
    const result = projectResult();
    vi.spyOn(store.api, "getProject").mockResolvedValue(result);
    await store.openProject(result.project.orderId);
    let finish!: (value: Awaited<ReturnType<typeof store.api.config>>) => void;
    vi.spyOn(store.api, "config").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const checking = store.checkConnection();
    const streamCount = vi.mocked(subscribeEvents).mock.calls.length;
    store.dispose();
    finish({ demoMode: true, mockProviders: {}, maxContextBytes: 100 });
    await checking;
    expect(subscribeEvents).toHaveBeenCalledTimes(streamCount);
  });
  it("returns the newest confirmed snapshot to a tool when its own response is older", async () => {
    const { store } = await fixture();
    const old = projectResult();
    const current = { ...old, project: { ...old.project, revision: 20 } };
    vi.spyOn(store.api, "getProject").mockResolvedValue(current);
    await store.openProject(current.project.orderId);
    vi.spyOn(store.api, "command").mockResolvedValue(old);
    const returned = await store.command({
      name: "get_project_status",
      args: {},
    });
    expect(returned.project.revision).toBe(20);
    store.dispose();
  });
  it("coalesces duplicate UI clicks and retries failed requests with the same action ID", async () => {
    const { store } = await fixture();
    const result = projectResult();
    vi.spyOn(store.api, "createProject").mockResolvedValue(result);
    const execute = vi
      .spyOn(store.api, "command")
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(result);
    const command = { name: "cancel_project", args: {} } as const;
    const first = store.command(command);
    expect(store.command(command)).toBe(first);
    await expect(first).rejects.toThrow("Offline");
    await store.command(command);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[2]).toBe(execute.mock.calls[0]?.[2]);
    store.dispose();
  });
  it("does not attach delayed clipboard or screen context after switching", async () => {
    const { store } = await fixture();
    let finish!: (files: File[]) => void;
    const upload = vi.spyOn(store, "upload");
    const captured = store.uploadFrom(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const rejected = expect(captured).rejects.toMatchObject({
      name: "AbortError",
    });
    await store.newProject();
    finish([new File(["private"], "clipboard.txt")]);
    await rejected;
    expect(upload).not.toHaveBeenCalled();
    store.dispose();
  });
  it("ignores old mutation snapshots and pending counters after a project switch", async () => {
    const { store } = await fixture();
    const original = projectResult();
    vi.spyOn(store.api, "getProject").mockResolvedValue(original);
    await store.openProject(original.project.orderId);
    let finish!: (value: typeof original) => void;
    vi.spyOn(store.api, "command").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = store.command(
      { name: "cancel_project", args: {} },
      "old-command",
    );
    const rejected = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(store.api.command).toHaveBeenCalledTimes(1));
    await store.newProject();
    finish({ ...original, project: { ...original.project, revision: 4 } });
    await rejected;
    expect(store.getSnapshot()).toMatchObject({
      project: null,
      pending: 0,
      error: null,
    });
    store.dispose();
  });
  it("never uploads the remainder of a context batch into a different project", async () => {
    const { store } = await fixture();
    const original = projectResult();
    vi.spyOn(store.api, "getProject").mockResolvedValue(original);
    await store.openProject(original.project.orderId);
    let finish!: (value: {
      contextId: string;
      asset: { assetId: string; checksum: string };
    }) => void;
    const upload = vi.spyOn(store.api, "uploadContext").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const attach = vi.spyOn(store.api, "command");
    const operation = store.upload([
      new File(["a"], "a.txt"),
      new File(["b"], "b.txt"),
    ]);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await store.newProject();
    finish({
      contextId: "old-context",
      asset: { assetId: "old-context", checksum: "a".repeat(64) },
    });
    await operation;
    expect(upload).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled();
    expect(store.getSnapshot().uploading).toEqual([]);
    store.dispose();
  });
  it("coalesces repeated actions and rejects conflicting reuse", async () => {
    const { store } = await fixture();
    const result = projectResult();
    vi.spyOn(store.api, "createProject").mockResolvedValue(result);
    const execute = vi.spyOn(store.api, "command").mockResolvedValue(result);
    await Promise.all([
      store.command({ name: "cancel_project", args: {} }, "same"),
      store.command({ name: "cancel_project", args: {} }, "same"),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      store.command({ name: "get_project_status", args: {} }, "same"),
    ).rejects.toThrow("reused");
    store.dispose();
  });
  it("preserves the newest revision and ignores other-project or duplicate events", async () => {
    const { store, notify } = await fixture();
    const result = projectResult();
    vi.spyOn(store.api, "getProject").mockResolvedValue({
      ...result,
      project: { ...result.project, revision: 8 },
    });
    await store.openProject(result.project.orderId);
    vi.spyOn(store.api, "command").mockResolvedValue(result);
    await store.command({ name: "get_project_status", args: {} });
    expect(store.getSnapshot().project?.revision).toBe(8);
    const event = backendEvent("supplier.offline", { merchantId: "supplier" });
    store.receive({ ...event, orderId: crypto.randomUUID() });
    expect(store.getSnapshot().failedMerchants).toEqual([]);
    store.receive(event);
    store.receive(event);
    expect(notify).toHaveBeenCalledTimes(1);
    store.dispose();
  });
  it("reports unavailable provider data independently of text connectivity", async () => {
    const { store } = await fixture();
    vi.spyOn(store.api, "marketplace").mockRejectedValue(new Error("404"));
    await store.refreshProviders();
    expect(store.getSnapshot()).toMatchObject({
      connection: "connected",
      marketplace: null,
      providerError: expect.stringContaining("unavailable"),
    });
    store.dispose();
  });
  it("offers resume without creating a project or voice session on launch", async () => {
    const { store } = await fixture();
    expect(store.getSnapshot().project).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    store.dispose();
  });
  it("uploads dropped files, attaches backend context IDs and reflects constraint mutations", async () => {
    const { store } = await fixture();
    const result = projectResult();
    vi.spyOn(store.api, "createProject").mockResolvedValue(result);
    const asset = {
      assetId: crypto.randomUUID(),
      name: "logo.png",
      mimeType: "image/png",
      checksum: "a".repeat(64),
    };
    const upload = vi
      .spyOn(store.api, "uploadContext")
      .mockResolvedValue({ contextId: asset.assetId, asset });
    const command = vi
      .spyOn(store.api, "command")
      .mockResolvedValue({ ...result, contexts: [asset] });
    const file = new File(["logo"], "logo.png");
    await store.upload([file]);
    expect(upload).toHaveBeenCalledWith(
      result.project.orderId,
      file,
      expect.any(String),
    );
    expect(command).toHaveBeenCalledWith(
      result.project.orderId,
      { name: "attach_context", args: { contextId: asset.assetId } },
      expect.stringMatching(/:attach$/),
    );
    expect(store.getSnapshot().attachments).toEqual([asset]);
    command.mockResolvedValue({
      ...result,
      contexts: [asset],
      project: { ...result.project, revision: 3, intentVersion: 2 },
    });
    await store.command(
      {
        name: "add_constraint",
        args: {
          constraint: {
            field: "material",
            operator: "not_contains",
            value: "polyester",
            hard: true,
          },
        },
      },
      "voice-correction",
    );
    expect(store.getSnapshot().project?.intentVersion).toBe(2);
    expect(store.getSnapshot().pending).toBe(0);
    store.dispose();
  });
  it("displays supplier failure and confirmed recovery, suppressing historical notifications", async () => {
    const { store, notify } = await fixture();
    const result = projectResult();
    vi.spyOn(store.api, "getProject").mockResolvedValue(result);
    await store.openProject(result.project.orderId);
    const failed = backendEvent("supplier.offline", {
      merchantId: "stitch-works",
    });
    store.receive(failed, true);
    expect(notify).not.toHaveBeenCalled();
    expect(store.getSnapshot().failedMerchants).toEqual(["stitch-works"]);
    const recovery = backendEvent("recovery.completed", {
      deadlinePreserved: true,
      costDelta: 0,
      approvalRequired: false,
    });
    store.receive(recovery);
    expect(store.getSnapshot().mode).toBe("alert");
    expect(store.getSnapshot().recovery).toEqual(recovery.payload);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "recovery.completed" }),
    );
    const plan = ProductionPlanSchema.parse({
      planId: "replacement",
      orderId: result.project.orderId,
      intentVersion: 2,
      status: "VALID",
      nodes: [],
      edges: [],
      totalCost: 150,
      currency: "CAD",
      riskScore: 0.2,
      constraintResults: [],
      unsatRelaxations: [],
    });
    vi.mocked(store.api.getProject).mockResolvedValue({
      ...result,
      project: { ...result.project, revision: 20, activePlan: plan },
    });
    const options = vi.mocked(subscribeEvents).mock.calls[0]![0];
    await options.refresh();
    expect(store.getSnapshot().project?.activePlan?.planId).toBe("replacement");
    expect(store.getSnapshot().project?.activePlan?.totalCost).toBe(150);
    store.dispose();
  });
});
