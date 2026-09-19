import { BrowserWindow, screen, systemPreferences } from "electron";
import { join } from "node:path";
import type { DesktopSignal, OverlayMode } from "../shared/bridge.js";
import { clampPosition, overlaySize } from "./policy.js";
import type { SettingsStore } from "./settings.js";

export class OverlayWindow {
  readonly window: BrowserWindow;
  private programmaticMove = false;
  private moveTimer?: ReturnType<typeof setTimeout>;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private mode: OverlayMode = "compact";
  private readonly fitDisplay = () => this.setMode(this.mode, false);
  constructor(
    private readonly settings: SettingsStore,
    rendererUrl?: string,
  ) {
    this.window = new BrowserWindow({
      width: 420,
      height: 188,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      fullscreenable: false,
      hasShadow: true,
      title: "Molecule",
      webPreferences: {
        preload: join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.on("close", (event) => {
      event.preventDefault();
      this.hide();
    });
    this.window.on("show", () =>
      this.signal({ type: "visibility", visible: true }),
    );
    this.window.on("hide", () =>
      this.signal({ type: "visibility", visible: false }),
    );
    this.window.on("moved", () => {
      if (this.programmaticMove) return;
      clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => {
        const [x = 0, y = 0] = this.window.getPosition();
        void settings.update({ position: { x, y } }).catch(() => {
          console.warn(
            JSON.stringify({ scope: "main", event: "position.save.failed" }),
          );
        });
      }, 250);
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", (event) =>
      event.preventDefault(),
    );
    screen.on("display-removed", this.fitDisplay);
    screen.on("display-metrics-changed", this.fitDisplay);
    void this.window.loadURL(rendererUrl ?? "app://molecule/index.html");
  }
  signal(signal: DesktopSignal) {
    this.window.webContents.send("desktop:signal", signal);
  }
  isVisible() {
    return this.window.isVisible();
  }
  isFocused() {
    return this.window.isFocused();
  }
  show() {
    const display = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    const area = display.workArea;
    const bounds = overlaySize(this.mode, area);
    const saved = this.settings.get().position;
    const onDisplay =
      saved &&
      saved.x >= area.x &&
      saved.x < area.x + area.width &&
      saved.y >= area.y &&
      saved.y < area.y + area.height;
    const position = onDisplay
      ? saved
      : { x: area.x + (area.width - bounds.width) / 2, y: area.y + 36 };
    this.programmaticMove = true;
    this.window.setBounds({
      ...clampPosition(position, bounds, area),
      ...bounds,
    });
    this.programmaticMove = false;
    this.window.show();
    this.window.focus();
  }
  hide() {
    this.window.hide();
  }
  setMode(mode: OverlayMode, animate = true) {
    if (mode === "hidden") return this.hide();
    this.mode = mode;
    const area = screen.getDisplayMatching(this.window.getBounds()).workArea;
    const { width, height } = overlaySize(mode, area);
    const position = clampPosition(
      this.window.getBounds(),
      { width, height },
      area,
    );
    this.programmaticMove = true;
    const motion =
      animate &&
      process.platform === "darwin" &&
      !systemPreferences.getAnimationSettings().prefersReducedMotion;
    clearTimeout(this.resizeTimer);
    this.window.setBounds({ ...position, width, height }, motion);
    if (motion)
      this.resizeTimer = setTimeout(() => {
        this.programmaticMove = false;
      }, 350);
    else this.programmaticMove = false;
  }
  destroy() {
    clearTimeout(this.moveTimer);
    clearTimeout(this.resizeTimer);
    screen.removeListener("display-removed", this.fitDisplay);
    screen.removeListener("display-metrics-changed", this.fitDisplay);
    this.window.removeAllListeners("close");
    this.window.destroy();
  }
}
