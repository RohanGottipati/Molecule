import { parseView, type WorkspaceView } from "./workspace";

export function projectHref(
  orderId: string | null,
  view: WorkspaceView = "command",
  search = "",
) {
  const params = new URLSearchParams(search);
  if (view === "command") params.delete("view");
  else params.set("view", view);
  const path = orderId ? `/projects/${encodeURIComponent(orderId)}` : "/";
  return params.size ? `${path}?${params}` : path;
}

export function parseWorkspaceLocation(pathname: string, search: string) {
  const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  let orderId: string | null = null;
  try {
    orderId = match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    /* Invalid URLs load no project. */
  }
  return { orderId, view: parseView(new URLSearchParams(search).get("view")) };
}

export function shouldHandleNavigation(
  event: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
  },
  target?: string,
  download = false,
) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!target || target === "_self") &&
    !download
  );
}

export function dockProjectHref(orderId: string): string | undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    orderId,
  )
    ? `molecule://project/${orderId}`
    : undefined;
}

export function relaxationDraft(
  field: string,
  value: unknown,
  currency = "CAD",
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return null;
  if (field === "quantity")
    return Number.isSafeInteger(value) ? `Quantity ${value}` : null;
  if (
    field === "budgetMax" &&
    currency === "CAD" &&
    value >= 0.01 &&
    value < 1e15 &&
    Number(value.toFixed(2)) === value
  )
    return `Budget CAD ${value.toLocaleString("en-CA", { useGrouping: false, maximumFractionDigits: 2 })}`;
  return null;
}
