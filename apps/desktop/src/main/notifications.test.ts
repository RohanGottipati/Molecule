import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSchema } from "../shared/bridge.js";
import { DesktopNotifications } from "./notifications.js";

class NativeNotice extends EventEmitter {
  show = vi.fn();
}
const notices: NativeNotice[] = [];
vi.mock("electron", () => ({
  Notification: class {
    static isSupported() {
      return true;
    }
    constructor() {
      const notice = new NativeNotice();
      notices.push(notice);
      return notice;
    }
  },
}));

const event = {
  eventId: "ec39b9e6-5bfa-4137-8474-72a651f877fd",
  projectId: "bc812dea-31c8-4258-a81d-08c7eeb14b97",
  kind: "supplier.offline",
  label: "Supplier failure detected. Molecule is rebuilding the company.",
};
function setup() {
  const settings = SettingsSchema.parse({ notificationsEnabled: true });
  const overlay = {
    isVisible: vi.fn(() => false),
    show: vi.fn(),
    signal: vi.fn(),
  };
  const notifications = new DesktopNotifications(
    { get: () => settings },
    overlay,
  );
  return { notifications, overlay, settings };
}

beforeEach(() => {
  notices.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("native notifications", () => {
  it("logs requested separately from the native show confirmation", () => {
    const { notifications } = setup();
    notifications.show(event);
    expect(notices[0]?.show).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        scope: "main",
        event: "notification.requested",
        kind: event.kind,
      }),
    );
    notices[0]?.emit("show");
    expect(console.info).toHaveBeenLastCalledWith(
      JSON.stringify({
        scope: "main",
        event: "notification.shown",
        kind: event.kind,
      }),
    );
  });

  it("preserves native failure details without claiming delivery", () => {
    const { notifications } = setup();
    notifications.show(event);
    notices[0]?.emit("failed", {}, "Notifications are not allowed");
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        scope: "main",
        event: "notification.failed",
        kind: event.kind,
        error: "Notifications are not allowed",
      }),
    );
    expect(console.info).toHaveBeenCalledTimes(1);
  });

  it("deduplicates events and opens the notification's project on click", () => {
    const { notifications, overlay } = setup();
    notifications.show(event);
    notifications.show(event);
    expect(notices).toHaveLength(1);
    notices[0]?.emit("click");
    expect(overlay.show).toHaveBeenCalledOnce();
    expect(overlay.signal).toHaveBeenCalledExactlyOnceWith({
      type: "project",
      projectId: event.projectId,
    });
  });

  it("does not notify while visible or when notifications are disabled", () => {
    const { notifications, overlay, settings } = setup();
    overlay.isVisible.mockReturnValue(true);
    notifications.show(event);
    overlay.isVisible.mockReturnValue(false);
    settings.notificationsEnabled = false;
    notifications.show(event);
    expect(notices).toHaveLength(0);
  });
});
