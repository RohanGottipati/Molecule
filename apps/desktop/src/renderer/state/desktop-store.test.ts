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
