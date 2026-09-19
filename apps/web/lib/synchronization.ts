import {
  deriveProjectCapabilities,
  hasUncompiledContext,
  type ActionStatus,
  type AssetRef,
  type MessageHistory,
  type OrderSessionSnapshot,
  type ProjectCapabilities,
} from "@molecule/contracts";
import { isUnresolved, type PendingAction } from "./persistence";

export type Freshness = "idle" | "loading" | "refreshing" | "fresh" | "stale";
export type CapabilitiesRead = {
  orderId: string;
  revision: number;
  capabilities: ProjectCapabilities;
};

export function safeCapabilities(
  order: OrderSessionSnapshot | null,
  read: CapabilitiesRead | null,
  freshness: Freshness,
  contexts: AssetRef[],
  blocked = false,
): ProjectCapabilities & { hasUncompiledContexts: boolean } {
  const hasUncompiledContexts = hasUncompiledContext(order, contexts);
  const ready =
    !blocked &&
    freshness === "fresh" &&
    !!order &&
    read?.orderId === order.orderId &&
    read.revision === order.revision;
  const local = order ? deriveProjectCapabilities(order) : null;
  return {
    canSubmitMessage:
      ready &&
      !!read?.capabilities.canSubmitMessage &&
      !!local?.canSubmitMessage,
    canCancelPlanning:
      ready &&
      !!read?.capabilities.canCancelPlanning &&
      !!local?.canCancelPlanning,
    canApprove:
      ready &&
      !!read?.capabilities.canApprove &&
      !!local?.canApprove &&
      !hasUncompiledContexts,
    requiresOperator:
      read?.orderId === order?.orderId
        ? (read?.capabilities.requiresOperator ?? false)
        : !!local?.requiresOperator,
    reason: !ready
      ? "Refresh and reconcile pending actions before making changes."
      : hasUncompiledContexts
        ? "Submit a brief update to compile the attached context before approval."
        : (read?.capabilities.reason ?? null),
    hasUncompiledContexts,
  };
}

export function reconcileAction(
  action: PendingAction,
  status: ActionStatus,
): PendingAction {
  if (
    status.orderId !== action.orderId ||
    status.key !== action.key ||
    status.kind !== action.kind
  )
    return action;
  if (
    ["succeeded", "failed", "superseded"].includes(action.status) &&
    ["unknown", "pending"].includes(status.status)
  )
    return action;
  return { ...action, status: status.status };
}

export function resumeCreatedAction(
  create: PendingAction,
  order: OrderSessionSnapshot,
  retained: PendingAction | null,
): PendingAction {
  const key = `message:${create.key}`;
  if (
    retained?.key === key &&
    retained.orderId === order.orderId &&
    retained.kind === "message"
  )
    return retained;
  if (isUnresolved(retained))
    throw new Error(
      "Open the existing project and resolve its pending action before retrying this brief.",
    );
  if (create.kind !== "create" || !create.payload)
    throw new Error("The original project request is unavailable.");
  return {
    ...create,
    kind: "message",
    key,
    orderId: order.orderId,
    traceId: order.traceId,
    payload: {
      ...create.payload,
      expectedRevision: create.payload.expectedRevision ?? order.revision,
    },
  };
}

export type ConversationEntry = {
  id: string;
  text: string;
  status: "sending" | "confirmed" | "unconfirmed";
  source?: MessageHistory["messages"][number]["source"];
  outcome?: MessageHistory["messages"][number]["outcome"];
  assets?: AssetRef[];
  acceptedAt?: string;
};

export function conversationEntries(
  history: MessageHistory["messages"],
  pending: PendingAction | null,
): ConversationEntry[] {
  const entries: ConversationEntry[] = history.map((entry) => ({
    id: entry.messageId,
    text: entry.text,
    source: entry.source,
    assets: entry.assets,
    acceptedAt: entry.acceptedAt,
    outcome: entry.outcome,
    status: entry.outcome.status === "succeeded" ? "confirmed" : "unconfirmed",
  }));
  if (pending?.payload && !entries.some((entry) => entry.id === pending.key))
    entries.push({
      id: pending.key,
      text: pending.payload.text,
      status: pending.status === "succeeded" ? "confirmed" : "unconfirmed",
    });
  return entries;
}

export function createReadQueue(
  read: () => Promise<void>,
  onError: (cause: unknown) => void,
  delay = 150,
) {
  let stopped = false;
  let running: Promise<void> | null = null;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const schedule = (wait: number) => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, wait);
  };
  const flush = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      queued = true;
      return running;
    }
    clearTimeout(timer);
    timer = undefined;
    queued = false;
    running = read()
      .then(() => {
        failures = 0;
      })
      .catch((cause: unknown) => {
        failures++;
        if (!stopped) onError(cause);
      })
      .finally(() => {
        running = null;
        if (!stopped && (queued || failures))
          schedule(
            failures
              ? Math.min(10_000, 500 * 2 ** Math.min(failures - 1, 5))
              : delay,
          );
      });
    return running;
  };
  return {
    request() {
      if (running) queued = true;
      else schedule(delay);
    },
    flush,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
