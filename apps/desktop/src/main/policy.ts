import { z } from "zod";
import { DashboardViewSchema, type DashboardView } from "../shared/bridge.js";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function serviceOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !loopbackHosts.has(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Use an HTTPS service origin or local HTTP origin without credentials.",
    );
  return url.origin;
}

export function rendererOrigin(value?: string): string {
  if (!value) return "app://molecule";
  const origin = serviceOrigin(value);
  if (!loopbackHosts.has(new URL(origin).hostname))
    throw new Error("Renderer must be local");
  return origin;
}

export function isTrustedFrame(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      `${url.protocol}//${url.host}` === origin
    );
  } catch {
    return false;
  }
}

export function allowsIpcSender(
  sender: { id: number; mainFrame: boolean; url: string },
  expectedId: number,
  origin: string,
): boolean {
  return (
    sender.id === expectedId &&
    sender.mainFrame &&
    isTrustedFrame(sender.url, origin)
  );
}

export function allowsMediaCheck(
  permission: string,
  mediaType: string | undefined,
  selected: boolean,
) {
  return permission === "display-capture"
    ? selected
    : permission === "media" &&
        (mediaType === "audio" || (mediaType === "unknown" && selected));
}

export function allowsMediaRequest(
  permission: string,
  mediaTypes: readonly string[] | undefined,
  hasScreenSelection: boolean,
): boolean {
  if (permission === "display-capture") return hasScreenSelection;
  if (permission !== "media" || !mediaTypes) return false;
  if (mediaTypes.length === 0) return hasScreenSelection;
  return mediaTypes.length === 1 && mediaTypes[0] === "audio";
}

export function dashboardUrl(
  base: string,
  projectId?: string,
  view?: DashboardView,
): string {
  const url = new URL(serviceOrigin(base));
  if (projectId && !z.uuid().safeParse(projectId).success)
    throw new Error("Invalid project");
  url.pathname = projectId ? `/projects/${encodeURIComponent(projectId)}` : "/";
  url.search = "";
  if (view !== undefined) {
    if (!projectId)
      throw new Error("A project is required for a workspace view");
    url.searchParams.set("view", DashboardViewSchema.parse(view));
  }
  url.hash = "";
  return url.href;
}

export function projectFromLink(value: string): string | null {
  try {
    const url = new URL(value);
    const id = url.pathname.slice(1);
    return url.protocol === "molecule:" &&
      url.hostname === "project" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      z.uuid().safeParse(id).success
      ? id
      : null;
  } catch {
    return null;
  }
}

export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}
export function registerShortcut(
  registry: ShortcutRegistry,
  preferred: string,
  toggle: () => void,
): string | null {
  for (const key of new Set([preferred, "CommandOrControl+Shift+M"])) {
    try {
      if (registry.register(key, toggle)) return key;
    } catch {
      /* Invalid accelerators fall back. */
    }
  }
  return null;
}

export function toggleWindow(window: {
  isVisible(): boolean;
  show(): void;
  hide(): void;
}) {
  if (window.isVisible()) window.hide();
  else window.show();
}

export function clampPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  area: { x: number; y: number; width: number; height: number },
) {
  return {
    x: Math.round(
      Math.max(area.x, Math.min(position.x, area.x + area.width - size.width)),
    ),
    y: Math.round(
      Math.max(
        area.y,
        Math.min(position.y, area.y + area.height - size.height),
      ),
    ),
  };
}
