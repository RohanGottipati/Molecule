import {
  ActionIdSchema,
  MessageSubmissionSchema,
  type MessageSubmission,
} from "@molecule/contracts";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type DraftScope = `project:${string}` | `new:${string}`;

export function browserStorage(
  kind: "localStorage" | "sessionStorage" = "localStorage",
): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window[kind];
  } catch {
    return null;
  }
}

export function readStored(
  key: string,
  storage = browserStorage(),
): string | null {
  try {
    return storage?.getItem(`molecule:v1:${key}`) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(
  key: string,
  value: string | null,
  storage = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    if (value === null) storage.removeItem(`molecule:v1:${key}`);
    else storage.setItem(`molecule:v1:${key}`, value);
    return true;
  } catch {
    return false;
  }
}

export function newDraftScope(
  reset = false,
  storage = browserStorage("sessionStorage"),
): DraftScope {
  const existing = reset ? null : readStored("new-draft", storage);
  if (existing && /^new:[a-zA-Z0-9-]+$/.test(existing))
    return existing as DraftScope;
  const scope: DraftScope = `new:${crypto.randomUUID()}`;
  writeStored("new-draft", scope, storage);
  return scope;
}

export function readDraft(
  scope: DraftScope,
  storage = browserStorage(),
): string {
  return readStored(`draft:${scope}`, storage) ?? "";
}

export function saveDraft(
  scope: DraftScope,
  text: string,
  storage = browserStorage(),
): boolean {
  return writeStored(`draft:${scope}`, text || null, storage);
}

export type PendingAction = {
  key: string;
  orderId: string | null;
  traceId: string;
  kind: "create" | "message" | "approve" | "desktop" | "upload" | "recovery";
  payload: MessageSubmission | null;
  status: "unknown" | "pending" | "succeeded" | "failed" | "superseded";
};

export function readPending(
  scope: DraftScope,
  storage = browserStorage(),
  session = browserStorage("sessionStorage"),
): PendingAction | null {
  try {
    const key = readStored(`action-key:${scope}`, session);
    const value: unknown = JSON.parse(
      (key
        ? readStored(`action:${scope}:${key}`, storage)
        : readStored(`action:${scope}`, storage)) ?? "null",
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("key" in value) ||
      !ActionIdSchema.safeParse(value.key).success ||
      !("traceId" in value) ||
      typeof value.traceId !== "string" ||
      !("orderId" in value) ||
      !(value.orderId === null || typeof value.orderId === "string") ||
      !("kind" in value) ||
      ![
        "create",
        "message",
        "approve",
        "desktop",
        "upload",
        "recovery",
      ].includes(String(value.kind)) ||
      !("status" in value) ||
      !["unknown", "pending", "succeeded", "failed", "superseded"].includes(
        String(value.status),
      ) ||
      !("payload" in value) ||
      !(
        value.payload === null ||
        MessageSubmissionSchema.safeParse(value.payload).success
      )
    )
      return null;
    if (scope.startsWith("project:") && value.orderId !== scope.slice(8))
      return null;
    if (
      (value.kind === "message" || value.kind === "create") &&
      value.payload === null
    )
      return null;
    return value as PendingAction;
  } catch {
    return null;
  }
}

export function savePending(
  scope: DraftScope,
  action: PendingAction | null,
  storage = browserStorage(),
  session = browserStorage("sessionStorage"),
) {
  if (action) {
    const durable = writeStored(
      `action:${scope}:${action.key}`,
      JSON.stringify(action),
      storage,
    );
    const tab = writeStored(`action-key:${scope}`, action.key, session);
    const fallback = writeStored(
      `action:${scope}`,
      JSON.stringify(action),
      storage,
    );
    return durable && fallback && tab;
  }
  const previous = readPending(scope, storage, session);
  if (previous) writeStored(`action:${scope}:${previous.key}`, null, storage);
  writeStored(`action-key:${scope}`, null, session);
  return writeStored(`action:${scope}`, null, storage);
}

export function isUnresolved(action: PendingAction | null) {
  return action?.status === "unknown" || action?.status === "pending";
}
