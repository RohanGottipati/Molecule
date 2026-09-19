import { MoleculeEventSchema, type MoleculeEvent } from "@molecule/contracts";

export interface Activity {
  id: string;
  kind: string;
  label: string;
  severity: "info" | "warning" | "error" | "success";
  timestamp: string;
  merchantId?: string;
  alert: boolean;
  notification?: string;
}
const labels: Record<string, string> = {
  "order.created": "Project created",
  "intent.received": "Understanding your request",
  "intent.compiled": "Requirements understood",
  "intent.clarification.required": "A few details are needed",
  "constraint.added": "Requirement added — rebuilding",
  "constraint.removed": "Requirement removed — rebuilding",
  "context.attached": "Context attached",
  "candidate.search.completed": "Merchant candidates found",
  "merchant.quote.fanout.started": "Checking merchant availability",
  "merchant.quote.received": "Merchant quote received",
  "merchant.quote.timeout": "Merchant did not respond",
  "rox.conflict_detected": "Found conflicting inventory data",
  "rox.claim_resolved": "Supplier facts resolved",
  "tiger.risk_loaded": "Supplier reliability loaded",
  "solver.started": "Validating plan",
  "solver.valid": "Production plan validated",
  "solver.unsat": "No valid company can satisfy all current requirements.",
  "plan.invalidated": "Previous plan invalidated",
  "execution.approval.requested": "Your approval is required",
  "execution.started": "Creating commerce order",
  "shopify.product.created": "Shopify product created",
  "shopify.customer_order.created": "Customer order created",
  "supplier.offline": "Supplier lost. Rebuilding company…",
  "recovery.started": "Checking alternate capacity",
  "recovery.approval.required": "Replacement plan needs your approval",
  "recovery.completed": "Recovered",
  "recovery.failed": "Recovery needs your attention",
  "order.completed": "Production order completed",
  "project.cancelled": "Project cancelled",
};
const alerts = new Set([
  "supplier.offline",
  "solver.unsat",
  "execution.approval.requested",
  "recovery.approval.required",
  "recovery.completed",
  "recovery.failed",
]);
const notifications: Record<string, string> = {
  "supplier.offline":
    "Supplier failure detected. Molecule is rebuilding the company.",
  "execution.approval.requested": "Customer approval required.",
  "recovery.approval.required": "A replacement company needs your approval.",
  "shopify.product.created": "Your Shopify product is ready.",
  "recovery.completed": "Molecule recovered your supply chain.",
  "recovery.failed": "Molecule needs help to restore your supply chain.",
  "solver.unsat": "No valid company can satisfy all current requirements.",
};
export function mapEvent(event: MoleculeEvent): Activity | null {
  let label = labels[event.eventType];
  if (!label) return null;
  if (
    event.eventType === "candidate.search.completed" &&
    typeof event.payload.count === "number"
  )
    label = `${event.payload.count} merchant candidates found`;
  if (
    event.eventType === "merchant.quote.received" &&
    event.payload.status === "DECLINE"
  )
    label = "Merchant declined";
  return {
    id: event.eventId,
    kind: event.eventType,
    label,
    timestamp: event.ts,
    merchantId: event.merchantId,
    alert: alerts.has(event.eventType),
    notification: notifications[event.eventType],
    severity: ["supplier.offline", "solver.unsat", "recovery.failed"].includes(
      event.eventType,
    )
      ? "error"
      : ["recovery.completed", "solver.valid"].includes(event.eventType)
        ? "success"
        : event.severity === "WARN" || event.eventType.includes("approval")
          ? "warning"
          : "info",
  };
}

export interface EventFrame {
  event: string;
  id?: number;
  data: string;
}
export function parseFrame(block: string): EventFrame {
  const data: string[] = [];
  let event = "message";
  let id: number | undefined;
  for (const line of block.split(/\r?\n/)) {
    const index = line.indexOf(":");
    const name = index < 0 ? line : line.slice(0, index);
    const value = index < 0 ? "" : line.slice(index + 1).replace(/^ /, "");
    if (name === "event") event = value;
    if (
      name === "id" &&
      /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value))
    )
      id = Number(value);
    if (name === "data") data.push(value);
  }
  return { event, id, data: data.join("\n") };
}
export async function consumeEvents(
  stream: ReadableStream<Uint8Array>,
  onFrame: (frame: EventFrame) => void,
  signal?: AbortSignal,
) {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let delimiter = /\r?\n\r?\n/.exec(buffer);
      while (delimiter) {
        if (signal?.aborted) return;
        if (delimiter.index > 1_000_000)
          throw new Error("Event frame too large");
        onFrame(parseFrame(buffer.slice(0, delimiter.index)));
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
        delimiter = /\r?\n\r?\n/.exec(buffer);
      }
      if (buffer.length > 1_000_000) throw new Error("Event frame too large");
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
export function subscribeEvents(options: {
  url: string;
  signal: AbortSignal;
  cursor?: number;
  transport?: typeof fetch;
  onEvent: (event: MoleculeEvent, cursor: number, replay: boolean) => void;
  onStatus: (
    status: "connecting" | "connected" | "reconnecting" | "offline",
  ) => void;
  refresh: (signal?: AbortSignal) => Promise<void>;
}) {
  let cursor = options.cursor ?? 0;
  return (async () => {
    let failures = 0;
    while (!options.signal.aborted && failures < 5) {
      options.onStatus(failures ? "reconnecting" : "connecting");
      try {
        let replay = true;
        const controller = new AbortController();
        const abort = () => controller.abort();
        options.signal.addEventListener("abort", abort, { once: true });
        let timer = setTimeout(abort, 30_000);
        let response: Response | undefined;
        try {
          response = await (options.transport ?? fetch)(options.url, {
            headers: {
              Accept: "text/event-stream",
              "Last-Event-ID": String(cursor),
            },
            signal: controller.signal,
            redirect: "error",
          });
          if (!response.ok || !response.body)
            throw new Error("Stream unavailable");
          await options.refresh(controller.signal);
          await consumeEvents(
            response.body,
            (frame) => {
              if (options.signal.aborted) return;
              clearTimeout(timer);
              timer = setTimeout(abort, 45_000);
              if (frame.event === "ready") {
                replay = false;
                failures = 0;
                options.onStatus("connected");
                return;
              }
              if (frame.event !== "molecule" || !frame.id || frame.id <= cursor)
                return;
              const event = MoleculeEventSchema.parse(JSON.parse(frame.data));
              cursor = frame.id;
              options.onEvent(event, cursor, replay);
            },
            controller.signal,
          );
        } finally {
          clearTimeout(timer);
          options.signal.removeEventListener("abort", abort);
          controller.abort();
          if (response?.body && !response.body.locked)
            await response.body.cancel().catch(() => undefined);
        }
        throw new Error("Stream closed");
      } catch {
        if (options.signal.aborted) return;
        failures += 1;
        options.onStatus(failures === 5 ? "offline" : "reconnecting");
        if (failures < 5)
          await delay(
            Math.min(8000, 500 * 2 ** (failures - 1)),
            options.signal,
          );
      }
    }
  })();
}
