import { Notification } from "electron";
import { z } from "zod";
import type { SettingsStore } from "./settings.js";
import type { OverlayWindow } from "./window.js";

const NoticeSchema = z.object({
  eventId: z.uuid(),
  projectId: z.uuid(),
  label: z.string().min(1).max(200),
  kind: z.enum([
    "supplier.offline",
    "execution.approval.requested",
    "recovery.approval.required",
    "shopify.product.created",
    "recovery.completed",
    "recovery.failed",
    "solver.unsat",
  ]),
});
export class DesktopNotifications {
  private readonly shown = new Set<string>();
  private readonly active = new Set<Notification>();
  constructor(
    private readonly settings: SettingsStore,
    private readonly overlay: OverlayWindow,
  ) {}
  show(value: unknown) {
    const event = NoticeSchema.parse(value);
    if (
      !this.settings.get().notificationsEnabled ||
      this.overlay.isVisible() ||
      this.shown.has(event.eventId)
    )
      return;
    if (!Notification.isSupported())
      throw new Error("Native notifications are unavailable on this system");
    this.shown.add(event.eventId);
    if (this.shown.size > 1000)
      this.shown.delete(this.shown.values().next().value!);
    const notification = new Notification({
      title: "Molecule",
      body: event.label,
      silent: false,
    });
    this.active.add(notification);
    notification.on("click", () => {
      this.overlay.show();
      this.overlay.signal({ type: "project", projectId: event.projectId });
    });
    notification.on("close", () => this.active.delete(notification));
    notification.on("failed", () => {
      this.active.delete(notification);
      console.warn(
        JSON.stringify({
          scope: "main",
          event: "notification.failed",
          kind: event.kind,
        }),
      );
    });
    notification.show();
    console.info(
      JSON.stringify({
        scope: "main",
        event: "notification.shown",
        kind: event.kind,
      }),
    );
  }
}
