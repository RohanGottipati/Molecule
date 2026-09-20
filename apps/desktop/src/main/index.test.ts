import { afterEach, expect, it, vi } from "vitest";
import { SettingsSchema } from "../shared/bridge.js";

interface Sender {
  sender: { id: number };
  senderFrame: { url: string };
}
interface MenuItem {
  label?: string;
  click?: () => void;
}
const native = vi.hoisted(() => ({
  frame: { url: "app://molecule/index.html" },
  handlers: new Map<string, (event: Sender, value: unknown) => unknown>(),
  lifecycle: new Map<string, () => void>(),
  menu: [] as MenuItem[],
  open: vi.fn(async () => undefined),
  quit: vi.fn(),
  update: vi.fn(async (_patch: unknown) => undefined),
}));
vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  app: {
    isPackaged: true,
    setName: vi.fn(),
    on: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: async () => undefined,
    getPath: () => "/virtual/settings",
    setAsDefaultProtocolClient: vi.fn(),
    quit: native.quit,
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    },
  },
  ipcMain: {
    handle: (
      name: string,
      action: (event: Sender, value: unknown) => unknown,
    ) => native.handlers.set(name, action),
  },
  globalShortcut: {
    register: () => true,
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  },
  shell: { openExternal: native.open },
  net: { fetch: vi.fn() },
  systemPreferences: {},
  nativeImage: { createFromBitmap: () => ({ setTemplateImage: vi.fn() }) },
  Menu: {
    buildFromTemplate: (items: MenuItem[]) => {
      native.menu = items;
      return items;
    },
  },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
  },
}));
vi.mock("./settings.js", () => ({
  SettingsStore: class {
    async load() {}
    get() {
      return SettingsSchema.parse({
        lastProjectId: "bc812dea-31c8-4258-a81d-08c7eeb14b97",
      });
    }
    update = native.update;
  },
}));
vi.mock("./window.js", () => ({
  OverlayWindow: class {
    window = {
      webContents: {
        id: 1,
        mainFrame: native.frame,
        on: (name: string, action: () => void) =>
          native.lifecycle.set(name, action),
      },
    };
    show() {}
    signal() {}
  },
}));
vi.mock("./context.js", () => ({
  ScreenContext: class {},
  pasteFiles: vi.fn(),
}));
vi.mock("./notifications.js", () => ({ DesktopNotifications: class {} }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("routes tray handoff from UUID-safe current selection despite slow or failed resume writes", async () => {
  vi.stubGlobal("__dirname", "/virtual/main");
  vi.stubEnv("WEB_APP_URL", "http://localhost:3000");
  vi.stubEnv("ORCHESTRATOR_URL", "http://localhost:3001");
  await import("./index.js");
  await vi.waitFor(() => expect(native.menu.length).toBeGreaterThan(0));
  expect(native.quit).not.toHaveBeenCalled();
  const trusted = { sender: { id: 1 }, senderFrame: native.frame };
  const select = native.handlers.get("desktop:active-project")!;
  const dashboard = native.handlers.get("desktop:dashboard")!;
  const settings = native.handlers.get("desktop:settings")!;
  const tray = native.menu.find(
    (item) => item.label === "Open Command Center",
  )!.click!;
  const projectId = "bb812dea-31c8-4258-a81d-08c7eeb14b97";
  tray();
  expect(native.open).toHaveBeenLastCalledWith("http://localhost:3000/");
  select(trusted, projectId);
  let fail!: (error: Error) => void;
  native.update.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const saving = settings(trusted, { lastProjectId: projectId });
  const rejected = expect(saving).rejects.toThrow("Disk full");
  tray();
  expect(native.open).toHaveBeenLastCalledWith(
    `http://localhost:3000/projects/${projectId}`,
  );
  select(trusted, null);
  fail(new Error("Disk full"));
  await rejected;
  tray();
  expect(native.open).toHaveBeenLastCalledWith("http://localhost:3000/");
  expect(() => select(trusted, "../secret")).toThrow();
  expect(() => select({ ...trusted, sender: { id: 2 } }, projectId)).toThrow(
    "Untrusted",
  );
  expect(() =>
    select({ ...trusted, senderFrame: { url: native.frame.url } }, projectId),
  ).toThrow("Untrusted");
  expect(() => dashboard(trusted, { projectId, view: "invalid" })).toThrow();
  await dashboard(trusted, projectId);
  expect(native.open).toHaveBeenLastCalledWith(
    `http://localhost:3000/projects/${projectId}`,
  );
  await dashboard(trusted, { projectId, view: "execution" });
  expect(native.open).toHaveBeenLastCalledWith(
    `http://localhost:3000/projects/${projectId}?view=execution`,
  );
  select(trusted, projectId);
  native.lifecycle.get("did-start-loading")!();
  tray();
  expect(native.open).toHaveBeenLastCalledWith("http://localhost:3000/");
});
