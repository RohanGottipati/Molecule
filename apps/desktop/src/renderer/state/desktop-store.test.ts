import { ProductionPlanSchema } from "@molecule/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopStore } from "./desktop-store.js";
import {
  backendEvent,
  mockBridge,
  projectResult,
} from "../services/test-fixtures.js";
import { subscribeEvents } from "../services/events.js";
import { ApiError } from "../services/molecule-api.js";

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
  it("retains the observed revision when retrying a command after another surface updates", async () => {
    const { store } = await fixture();
    const original = projectResult();
    original.project.revision = 4;
    const read = vi.spyOn(store.api, "getProject").mockResolvedValue(original);
    await store.openProject(original.project.orderId);
    const execute = vi
      .spyOn(store.api, "command")
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValue(original);
    const command = {
      name: "start_project",
      args: { intent: "No polyester." },
    } as const;
    await expect(store.command(command)).rejects.toThrow("Response lost");
    read.mockResolvedValue({
      ...original,
      project: { ...original.project, revision: 20 },
    });
    await store.refresh();
    await store.command(command);
    expect(execute.mock.calls[0]?.[3]).toBe(4);
    expect(execute.mock.calls[1]).toEqual(execute.mock.calls[0]);
    expect(store.getSnapshot().project?.revision).toBe(20);
    store.dispose();
  });
  it("cancels pending capture on hide without uploading a late frame", async () => {
    const { store } = await fixture();
    let finish!: (files: File[]) => void;
    let signal!: AbortSignal;
    const upload = vi.spyOn(store, "upload");
    const captured = store.uploadFrom((value) => {
      signal = value;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const rejected = expect(captured).rejects.toMatchObject({
      name: "AbortError",
    });
    store.setVisible(false);
    expect(signal.aborted).toBe(true);
    finish([new File(["frame"], "screen.png", { type: "image/png" })]);
    await rejected;
    expect(upload).not.toHaveBeenCalled();
    store.dispose();
  });
  it("clears obsolete approval alerts when replay reaches execution", async () => {
    const { store, notify } = await fixture();
    const result = projectResult();
    vi.spyOn(store.api, "getProject").mockResolvedValue(result);
    await store.openProject(result.project.orderId);
    store.receive(backendEvent("execution.approval.requested"), true);
    expect(store.getSnapshot().alert?.kind).toBe(
      "execution.approval.requested",
    );
    store.receive(backendEvent("execution.started"), true);
    expect(store.getSnapshot().alert).toBeNull();
    store.receive(backendEvent("solver.unsat"), true);
    store.receive(backendEvent("project.cancelled"), true);
    expect(store.getSnapshot().alert).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    store.dispose();
  });
  it("serializes preference patches with project resume updates", async () => {
    const { store, bridge } = await fixture();
    const result = projectResult();
    vi.spyOn(store.api, "getProject").mockResolvedValue(result);
    await Promise.all([
      store.settings({ voiceEnabled: false }),
      store.openProject(result.project.orderId),
    ]);
    expect(store.getSnapshot().bootstrap?.settings).toMatchObject({
      voiceEnabled: false,
      lastProjectId: result.project.orderId,
    });
    expect((await bridge.bootstrap()).settings.voiceEnabled).toBe(false);
    store.dispose();
  });
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
      replacementPlanId: "replacement",
      deadlinePreserved: true,
      costDelta: 0,
      approvalRequired: false,
    });
    store.receive(recovery);
    expect(store.getSnapshot().mode).toBe("alert");
    expect(store.getSnapshot().recovery).toBeNull();
    expect(store.getSnapshot().recoveryHistory).toEqual([recovery.payload]);
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
      project: {
        ...result.project,
        revision: 20,
        intentVersion: 2,
        state: "COMPLETED",
        activePlan: plan,
      },
    });
    const options = vi.mocked(subscribeEvents).mock.calls[0]![0];
    await options.refresh();
    expect(store.getSnapshot().project?.activePlan?.planId).toBe("replacement");
    expect(store.getSnapshot().project?.activePlan?.totalCost).toBe(150);
    expect(store.getSnapshot().recovery).toEqual(recovery.payload);
    store.dispose();
  });
  it.each([0, 1])(
    "merges confirmed contexts when a delayed GET returns revision %s",
    async (revision) => {
      const { store } = await fixture();
      const original = projectResult();
      original.project.revision = 1;
      const get = vi.spyOn(store.api, "getProject").mockResolvedValue(original);
      await store.openProject(original.project.orderId);
      let finish!: (value: typeof original) => void;
      get.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const refresh = store.refresh();
      const asset = { assetId: crypto.randomUUID(), checksum: "a".repeat(64) };
      vi.spyOn(store.api, "uploadContext").mockResolvedValue({
        contextId: asset.assetId,
        asset,
      });
      vi.spyOn(store.api, "command").mockResolvedValue({
        ...original,
        contexts: [asset],
      });
      await store.upload([new File(["logo"], "logo.png")]);
      finish({ ...original, project: { ...original.project, revision } });
      await refresh;
      expect(store.getSnapshot().attachments).toEqual([asset]);
      expect(store.getSnapshot().project?.revision).toBe(1);
      get.mockResolvedValue(original);
      await store.openProject(original.project.orderId);
      expect(store.getSnapshot().attachments).toEqual([]);
      store.dispose();
    },
  );
  it("isolates delayed attachment reads by selection epoch even when reopening the same project", async () => {
    const { store } = await fixture();
    const result = projectResult();
    const get = vi.spyOn(store.api, "getProject").mockResolvedValue(result);
    await store.openProject(result.project.orderId);
    const epoch = store.getSnapshot().selectionEpoch;
    let finish!: (value: typeof result) => void;
    get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = store.refresh();
    await store.openProject(result.project.orderId);
    finish({
      ...result,
      contexts: [{ assetId: crypto.randomUUID(), checksum: "a".repeat(64) }],
    });
    await refresh;
    expect(store.getSnapshot().selectionEpoch).toBeGreaterThan(epoch);
    expect(store.getSnapshot().attachments).toEqual([]);
    store.dispose();
  });
  it("retains partial batch failures and reuses uncertain upload and attach receipts", async () => {
    const { store } = await fixture();
    const original = projectResult();
    vi.spyOn(store.api, "createProject").mockResolvedValue(original);
    const asset = { assetId: crypto.randomUUID(), checksum: "a".repeat(64) };
    const upload = vi
      .spyOn(store.api, "uploadContext")
      .mockRejectedValueOnce(
        new ApiError("Check the action outcome.", 0, "NETWORK_ERROR"),
      )
      .mockResolvedValue({ contextId: asset.assetId, asset });
    const command = vi
      .spyOn(store.api, "command")
      .mockResolvedValue({ ...original, contexts: [asset] });
    const results = await store.upload([
      new File(["first"], "first.txt"),
      new File(["second"], "second.txt"),
    ]);
    expect(results.map((result) => result.outcome)).toEqual([
      "unknown",
      "confirmed",
    ]);
    expect(store.getSnapshot().error).toContain("first.txt");
    command.mockRejectedValueOnce(
      new ApiError("Check the action outcome.", 0, "NETWORK_ERROR"),
    );
    const retry = await store.upload([new File(["first"], "first.txt")]);
    expect(upload.mock.calls[2]?.[2]).toBe(results[0]?.actionId);
    expect(retry[0]).toMatchObject({
      stage: "attach",
      outcome: "unknown",
      contextId: asset.assetId,
    });
    const recovered = await store.upload([new File(["first"], "first.txt")]);
    expect(recovered[0]).toMatchObject({
      outcome: "confirmed",
      actionId: results[0]?.actionId,
    });
    expect(upload).toHaveBeenCalledTimes(3);
    expect(command.mock.calls[1]?.[2]).toBe(command.mock.calls[2]?.[2]);
    expect(store.getSnapshot().error).toBeNull();
    store.dispose();
  });
  it("reports file-read and validation failures without losing later successes", async () => {
    const { store } = await fixture();
    const original = projectResult();
    vi.spyOn(store.api, "createProject").mockResolvedValue(original);
    const asset = { assetId: crypto.randomUUID(), checksum: "b".repeat(64) };
    vi.spyOn(store.api, "uploadContext")
      .mockRejectedValueOnce(
        new ApiError(
          "Check request fields.",
          400,
          "VALIDATION_ERROR",
          "trace-upload",
          false,
        ),
      )
      .mockResolvedValue({ contextId: asset.assetId, asset });
    vi.spyOn(store.api, "command").mockResolvedValue({
      ...original,
      contexts: [asset],
    });
    const unreadable = new File(["data"], "unreadable.txt");
    vi.spyOn(unreadable, "arrayBuffer").mockRejectedValue(
      new Error("Private path"),
    );
    const results = await store.upload([
      unreadable,
      new File(["invalid"], "program.exe"),
      new File(["reject"], "reject.txt"),
      new File(["ok"], "ok.txt"),
    ]);
    expect(results.map((result) => result.outcome)).toEqual([
      "failed",
      "failed",
      "failed",
      "confirmed",
    ]);
    expect(store.getSnapshot().error).toContain("unreadable.txt");
    expect(store.getSnapshot().error).not.toContain("Private path");
    expect(store.getSnapshot().error).toContain("program.exe");
    expect(store.getSnapshot().error).toContain("reject.txt");
    expect(store.getSnapshot().errorDetails).toMatchObject({
      code: "VALIDATION_ERROR",
      traceId: "trace-upload",
    });
    store.dispose();
  });
  it("keeps cancelled compilation available independently of other pending operations", async () => {
    const { store } = await fixture();
    const original = projectResult();
    vi.spyOn(store.api, "getProject").mockResolvedValue(original);
    await store.openProject(original.project.orderId);
    let finish!: (value: typeof original) => void;
    const command = vi
      .spyOn(store.api, "command")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        ...original,
        project: { ...original.project, revision: 2, state: "CANCELLED" },
      });
    const compile = store.command({
      name: "start_project",
      args: { intent: "T-shirts" },
    });
    await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(store.getSnapshot().pendingOperations[0]?.name).toBe(
      "start_project",
    );
    expect(store.getCapabilities().canCancelPlanning).toBe(true);
    await store.command({ name: "cancel_project", args: {} });
    expect(store.getCapabilities().canCancelPlanning).toBe(false);
    expect(store.getCapabilities().canSubmitBrief).toBe(false);
    finish(original);
    await compile;
    expect(store.getSnapshot().project?.state).toBe("CANCELLED");
    expect(store.getSnapshot().pendingOperations).toEqual([]);
    store.dispose();
  });
  it("preserves server failure metadata and the action ID for failed receipts and transport uncertainty", async () => {
    const { store } = await fixture();
    vi.spyOn(store.api, "createProject").mockResolvedValue(projectResult());
    const command = vi
      .spyOn(store.api, "command")
      .mockRejectedValueOnce(new ApiError("Check outcome.", 0, "NETWORK_ERROR"))
      .mockRejectedValueOnce(
        new ApiError(
          "Reconcile receipt.",
          409,
          "CONFLICT",
          "trace-ledger",
          false,
        ),
      );
    const request = { name: "cancel_project", args: {} } as const;
    await expect(store.command(request)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    await expect(store.command(request)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(command.mock.calls[0]?.[2]).toBe(command.mock.calls[1]?.[2]);
    expect(store.getSnapshot().errorDetails).toMatchObject({
      traceId: "trace-ledger",
      retryable: false,
    });
    store.dispose();
  });
  it("retains the exact approval receipt after an incomplete execution snapshot", async () => {
    const { store } = await fixture();
    const original = projectResult();
    vi.spyOn(store.api, "createProject").mockResolvedValue(original);
    const result = {
      ...original,
      project: { ...original.project, state: "NEEDS_HUMAN" as const },
    };
    const execute = vi.spyOn(store.api, "command").mockResolvedValue(result);
    const approval = {
      name: "approve_action",
      args: { planId: "exact-plan", intentVersion: 1 },
    } as const;
    await store.command(approval);
    await store.command(approval);
    expect(execute).toHaveBeenCalledOnce();
    store.dispose();
  });
  it.each(["correction", "cancel", "replacement"] as const)(
    "invalidates current recovery after %s and retains history on replay",
    async (change) => {
      const { store, notify } = await fixture();
      const original = projectResult();
      const plan = ProductionPlanSchema.parse({
        planId: "recovered",
        orderId: original.project.orderId,
        intentVersion: 1,
        status: "VALID",
        nodes: [],
        edges: [],
        totalCost: 20,
        currency: "CAD",
        riskScore: 0,
        constraintResults: [],
        unsatRelaxations: [],
      });
      original.project = {
        ...original.project,
        activePlan: plan,
        intentVersion: 1,
        state: "AWAITING_APPROVAL",
      };
      const get = vi.spyOn(store.api, "getProject").mockResolvedValue(original);
      await store.openProject(original.project.orderId);
      store.receive(
        backendEvent("supplier.offline", { merchantId: "failed" }),
        true,
      );
      const event = backendEvent("recovery.approval.required", {
        replacementPlanId: plan.planId,
        costDelta: 0,
      });
      store.receive(event, true);
      expect(store.getSnapshot().recovery).toEqual(event.payload);
      store.receive(
        backendEvent("plan.invalidated", {
          reason: "customer_correction",
          previousPlanId: plan.planId,
        }),
      );
      await store.refresh();
      expect(store.getSnapshot().recovery).toBeNull();
      get.mockResolvedValue({
        ...original,
        project: {
          ...original.project,
          revision: 2,
          planGeneration: 2,
          state:
            change === "cancel"
              ? "CANCELLED"
              : change === "correction"
                ? "COMPILING_INTENT"
                : "AWAITING_APPROVAL",
          activePlan:
            change === "replacement" ? { ...plan, planId: "different" } : null,
        },
      });
      await store.refresh();
      store.receive({ ...event, eventId: crypto.randomUUID() }, true);
      expect(store.getSnapshot().recovery).toBeNull();
      expect(store.getSnapshot().recoveryHistory).toContainEqual(event.payload);
      expect(store.getSnapshot().failedMerchants).toEqual([]);
      expect(store.getSnapshot().failedMerchantHistory).toEqual(["failed"]);
      expect(notify).not.toHaveBeenCalled();
      store.dispose();
    },
  );
  it("keeps actionable failure history silent on replay and while visible", async () => {
    const { store, notify } = await fixture();
    vi.spyOn(store.api, "getProject").mockResolvedValue(projectResult());
    await store.openProject(projectResult().project.orderId);
    for (const kind of [
      "workflow.failed",
      "execution.failed",
      "execution.incomplete",
      "order.needs_human",
    ])
      store.receive(backendEvent(kind), true);
    expect(store.getSnapshot().activity).toHaveLength(4);
    expect(store.getSnapshot().alert?.kind).toBe("execution.incomplete");
    expect(notify).not.toHaveBeenCalled();
    store.setVisible(true);
    store.receive(backendEvent("workflow.failed"));
    expect(notify).not.toHaveBeenCalled();
    store.receive(backendEvent("recovery.completed"));
    store.receive(backendEvent("order.needs_human"));
    expect(store.getSnapshot().alert?.kind).toBe("order.needs_human");
    store.dispose();
  });
  it("publishes current project independently of delayed and failed resume persistence", async () => {
    const { store, bridge } = await fixture();
    bridge.setActiveProject = vi.fn(async () => undefined);
    const original = projectResult();
    vi.spyOn(store.api, "getProject").mockResolvedValue(original);
    let fail!: (error: Error) => void;
    vi.spyOn(bridge, "saveSettings").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const opening = store.openProject(original.project.orderId);
    const rejected = expect(opening).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledOnce());
    expect(bridge.setActiveProject).toHaveBeenLastCalledWith(
      original.project.orderId,
    );
    await store.newProject();
    expect(bridge.setActiveProject).toHaveBeenLastCalledWith(null);
    fail(new Error("Disk full"));
    await rejected;
    expect(bridge.setActiveProject).toHaveBeenLastCalledWith(null);
    expect(store.getSnapshot().project).toBeNull();
    store.dispose();
  });
});
