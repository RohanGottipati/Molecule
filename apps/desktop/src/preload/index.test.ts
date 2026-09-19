import { expect, it, vi } from "vitest";
import type { DesktopBridge } from "../shared/bridge.js";

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  expose: vi.fn<(name: string, bridge: DesktopBridge) => void>(),
}));
vi.mock("electron", () => ({
  ipcRenderer: { invoke: ipc.invoke },
  contextBridge: { exposeInMainWorld: ipc.expose },
}));

it("preserves legacy dashboard IPC and forwards exact view and current project selection", async () => {
  await import("./index.js");
  expect(ipc.expose).toHaveBeenCalledOnce();
  const bridge = ipc.expose.mock.calls[0]![1];
  const id = "bb812dea-31c8-4258-a81d-08c7eeb14b97";
  await bridge.openDashboard(id);
  expect(ipc.invoke).toHaveBeenLastCalledWith("desktop:dashboard", id);
  await bridge.openDashboard(id, "operations");
  expect(ipc.invoke).toHaveBeenLastCalledWith("desktop:dashboard", {
    projectId: id,
    view: "operations",
  });
  await bridge.setActiveProject?.(null);
  expect(ipc.invoke).toHaveBeenLastCalledWith("desktop:active-project", null);
});
