import {
  app,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { OverlayModeSchema, SettingsPatchSchema } from "../shared/bridge.js";
import {
  allowsMediaRequest,
  allowsMediaCheck,
  allowsIpcSender,
  dashboardUrl,
  projectFromLink,
  registerShortcut,
  toggleWindow,
  rendererOrigin,
  serviceOrigin,
  isTrustedFrame,
} from "./policy.js";
import { SettingsStore } from "./settings.js";
import { OverlayWindow } from "./window.js";
import { ScreenContext, pasteFiles } from "./context.js";
import { DesktopNotifications } from "./notifications.js";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.setName("Molecule");
const rendererUrl = !app.isPackaged
  ? process.env.DESKTOP_RENDERER_URL
  : undefined;
const apiUrl = new URL(
  serviceOrigin(process.env.ORCHESTRATOR_URL ?? "http://localhost:3001"),
);
const webUrl = serviceOrigin(
  process.env.WEB_APP_URL ?? "http://localhost:3000",
);
const trustedOrigin = rendererOrigin(rendererUrl);
const isTrusted = (url: string) => isTrustedFrame(url, trustedOrigin);
let overlay: OverlayWindow;
let shortcut: string | null = null;
let tray: Tray;
let pendingProject: string | null = null;
let rendererReady = false;
let screenContext: ScreenContext | undefined;
app.on("open-url", (event, url) => {
  event.preventDefault();
  const projectId = projectFromLink(url);
  if (!projectId) return;
  if (overlay && rendererReady) {
    overlay.show();
    overlay.signal({ type: "project", projectId });
  } else pendingProject = projectId;
});

if (!app.requestSingleInstanceLock()) app.quit();
else
  void app
    .whenReady()
    .then(async () => {
      app.dock?.hide();
      const settings = new SettingsStore(app.getPath("userData"));
      await settings.load();
      const root = resolve(__dirname, "../renderer");
      protocol.handle("app", (request) => {
        try {
          const url = new URL(request.url);
          const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
          if (url.hostname !== "molecule" || !file.startsWith(root + sep))
            return new Response(null, { status: 403 });
          return net.fetch(pathToFileURL(file).href);
        } catch {
          return new Response(null, { status: 400 });
        }
      });
      session.defaultSession.webRequest.onHeadersReceived(
        (details, callback) => {
          if (!isTrusted(details.url)) return callback({});
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              "Content-Security-Policy": [
                `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' ${apiUrl.origin} https://api.openai.com ${rendererUrl ? "ws://127.0.0.1:5173" : ""}; object-src 'none'; base-uri 'none'; frame-src 'none'`,
              ],
            },
          });
        },
      );
      session.defaultSession.setPermissionRequestHandler(
        (contents, permission, callback, details) => {
          callback(
            contents === overlay?.window.webContents &&
              details.isMainFrame &&
              isTrusted(details.requestingUrl) &&
              allowsMediaRequest(
                permission,
                "mediaTypes" in details ? details.mediaTypes : undefined,
                screenContext?.hasSelection() === true,
              ),
          );
        },
      );
      session.defaultSession.setPermissionCheckHandler(
        (contents, permission, origin, details) =>
          contents === overlay?.window.webContents &&
          details.isMainFrame &&
          allowsMediaCheck(
            permission,
            details.mediaType,
            screenContext?.hasSelection() === true,
          ) &&
          isTrusted(origin),
      );
      overlay = new OverlayWindow(settings, rendererUrl);
      screenContext = new ScreenContext(
        isTrusted,
        overlay.window.webContents.id,
      );
      const notices = new DesktopNotifications(settings, overlay);
      const revealProject = () => {
        if (!pendingProject) return;
        overlay.show();
        overlay.signal({ type: "project", projectId: pendingProject });
        pendingProject = null;
      };
      if (app.isPackaged) app.setAsDefaultProtocolClient("molecule");
      overlay.window.webContents.on("did-start-loading", () => {
        rendererReady = false;
      });
      const toggle = () => toggleWindow(overlay);
      shortcut = registerShortcut(
        globalShortcut,
        settings.get().shortcut,
        toggle,
      );
      console.info(
        JSON.stringify({
          scope: "main",
          event: "shortcut.registered",
          shortcut,
        }),
      );
      const bootstrap = () => ({
        apiUrl: apiUrl.origin,
        settings: settings.get(),
        shortcut,
      });
      function handle(channel: string, action: (value: unknown) => unknown) {
        ipcMain.handle(channel, (event, value: unknown) => {
          if (
            !allowsIpcSender(
              {
                id: event.sender.id,
                mainFrame:
                  event.senderFrame === overlay.window.webContents.mainFrame,
                url: event.senderFrame?.url ?? "",
              },
              overlay.window.webContents.id,
              trustedOrigin,
            )
          )
            throw new Error("Untrusted IPC sender");
          return action(value);
        });
      }
      handle("desktop:bootstrap", bootstrap);
      handle("desktop:ready", () => {
        rendererReady = true;
        revealProject();
      });
      handle("desktop:sources", () => screenContext?.list());
      handle("desktop:select-source", (value) =>
        screenContext?.select(z.string().max(200).parse(value)),
      );
      handle("desktop:paste", () => pasteFiles());
      handle("desktop:notify", (value) => notices.show(value));
      handle("desktop:hide", () => overlay.hide());
      handle("desktop:toggle", toggle);
      handle("desktop:mode", (mode) =>
        overlay.setMode(OverlayModeSchema.parse(mode)),
      );
      handle("desktop:dashboard", (id) =>
        shell.openExternal(dashboardUrl(webUrl, z.uuid().optional().parse(id))),
      );
      handle("desktop:settings", async (value) => {
        const next = SettingsPatchSchema.parse(value);
        const previousShortcut = settings.get().shortcut;
        await settings.update(next);
        if (next.shortcut !== undefined && next.shortcut !== previousShortcut) {
          if (shortcut) globalShortcut.unregister(shortcut);
          shortcut = registerShortcut(
            globalShortcut,
            settings.get().shortcut,
            toggle,
          );
        }
        return bootstrap();
      });
      handle("desktop:permissions", () => ({
        microphone:
          process.platform === "darwin"
            ? systemPreferences.getMediaAccessStatus("microphone")
            : "granted",
        screen:
          process.platform === "darwin"
            ? systemPreferences.getMediaAccessStatus("screen")
            : "granted",
      }));
      handle("desktop:microphone", () =>
        process.platform === "darwin"
          ? systemPreferences.askForMediaAccess("microphone")
          : true,
      );
      handle("desktop:permission-settings", (value) => {
        const kind = z.enum(["microphone", "screen"]).parse(value);
        if (process.platform === "darwin")
          return shell.openExternal(
            `x-apple.systempreferences:com.apple.preference.security?${kind === "microphone" ? "Privacy_Microphone" : "Privacy_ScreenCapture"}`,
          );
      });
      app.on("activate", () => overlay.show());
      app.on("before-quit", () => overlay.destroy());
      app.on("second-instance", (_event, argv) => {
        pendingProject =
          argv.map(projectFromLink).find((id) => id !== null) ?? null;
        overlay.show();
        if (rendererReady) revealProject();
      });
      const startVoice = () => {
        overlay.show();
        overlay.signal({ type: "start-voice" });
      };
      globalShortcut.register("Alt+Shift+Space", startVoice);
      const pixels = Buffer.alloc(18 * 18 * 4);
      for (let y = 3; y < 15; y++)
        for (let x = 3; x < 15; x++) {
          if (x < 6 || x > 11 || (Math.abs(x - 8.5) <= (y - 3) / 2 && y < 10)) {
            const index = (y * 18 + x) * 4;
            pixels[index + 3] = 255;
          }
        }
      const image = nativeImage.createFromBitmap(pixels, {
        width: 18,
        height: 18,
      });
      image.setTemplateImage(true);
      tray = new Tray(image);
      tray.setToolTip("Molecule");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Molecule", click: () => overlay.show() },
          { label: "Start / stop conversation", click: startVoice },
          {
            label: "Mute / unmute",
            click: () => overlay.signal({ type: "mute" }),
          },
          {
            label: "Open Command Center",
            click: () => {
              void shell.openExternal(
                dashboardUrl(webUrl, settings.get().lastProjectId),
              );
            },
          },
          {
            label: "Settings",
            click: () => {
              overlay.show();
              overlay.signal({ type: "settings" });
            },
          },
          { type: "separator" },
          { label: "Quit", click: () => app.quit() },
        ]),
      );
    })
    .catch(() => {
      console.error(JSON.stringify({ scope: "main", event: "fatal.startup" }));
      app.quit();
    });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => undefined);
