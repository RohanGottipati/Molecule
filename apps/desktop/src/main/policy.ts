export function dashboardUrl(base: string, projectId?: string): string {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid dashboard URL");
  if (projectId && !/^[a-f0-9-]{36}$/i.test(projectId))
    throw new Error("Invalid project");
  url.pathname = projectId ? `/projects/${encodeURIComponent(projectId)}` : "/";
  url.search = "";
  url.hash = "";
  return url.href;
}

export function projectFromLink(value: string): string | null {
  try {
    const url = new URL(value);
    const id = url.pathname.slice(1);
    return url.protocol === "molecule:" &&
      url.hostname === "project" &&
      /^[a-f0-9-]{36}$/i.test(id)
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
