import type { DesktopResult, MoleculeEvent } from "@molecule/contracts";
import { SettingsSchema, type DesktopBridge } from "../../shared/bridge.js";

export function projectResult(): DesktopResult {
  const now = new Date().toISOString();
  return {
    project: {
      orderId: "bb812dea-31c8-4258-a81d-08c7eeb14b97",
      traceId: "trace-desktop",
      state: "REQUESTED",
      revision: 0,
      intentVersion: 0,
      planGeneration: 0,
      intent: null,
      candidates: [],
      quotes: [],
      activePlan: null,
      executionReceipt: null,
      lastErrorCode: null,
      eventCursor: 0,
      createdAt: now,
      updatedAt: now,
    },
    contexts: [],
  };
}
export function backendEvent(
  eventType: string,
  payload: MoleculeEvent["payload"] = {},
): MoleculeEvent {
  return {
    eventId: crypto.randomUUID(),
    traceId: "trace-desktop",
    orderId: projectResult().project.orderId,
    eventType,
    ts: new Date().toISOString(),
    severity: "INFO",
    source: "orchestrator",
    payload,
  };
}
export function mockBridge(): DesktopBridge {
  const settings = SettingsSchema.parse({});
  return {
    bootstrap: async () => ({
      apiUrl: "http://localhost:3001",
      settings,
      shortcut: "Alt+Space",
    }),
    ready: async () => undefined,
    hideOverlay: async () => undefined,
    toggleOverlay: async () => undefined,
    setMode: async () => undefined,
    openDashboard: async () => undefined,
    saveSettings: async (next) => ({
      apiUrl: "http://localhost:3001",
      settings: next,
      shortcut: "Alt+Space",
    }),
    getPermissionStatus: async () => ({
      microphone: "granted",
      screen: "granted",
    }),
    requestMicrophone: async () => true,
    openPermissionSettings: async () => undefined,
    notify: async () => undefined,
    listScreenSources: async () => [],
    selectScreenSource: async () => undefined,
    pasteFiles: async () => [],
    onSignal: () => () => undefined,
  };
}
