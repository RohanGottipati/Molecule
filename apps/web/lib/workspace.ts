import {
  MoleculeEventSchema,
  type AssetRef,
  type MoleculeEvent,
  type OrderSessionSnapshot,
  type ProductionPlan,
} from "@molecule/contracts";

export const views = [
  "command",
  "merchants",
  "reality",
  "operations",
  "execution",
] as const;
export type WorkspaceView = (typeof views)[number];
export function parseView(value: string | null): WorkspaceView {
  return views.find((view) => view === value) ?? "command";
}

export function mergeSnapshot(
  current: OrderSessionSnapshot | null,
  next: OrderSessionSnapshot,
  orderId: string,
): OrderSessionSnapshot | null {
  if (next.orderId !== orderId) return current;
  if (
    current?.orderId === orderId &&
    (next.revision < current.revision ||
      next.intentVersion < current.intentVersion ||
      next.planGeneration < current.planGeneration ||
      next.eventCursor < current.eventCursor)
  )
    return current;
  return next;
}

export function parseEvent(
  data: string,
  orderId: string,
): MoleculeEvent | null {
  try {
    const result = MoleculeEventSchema.safeParse(JSON.parse(data));
    return result.success && result.data.orderId === orderId
      ? result.data
      : null;
  } catch {
    return null;
  }
}

export function mergeEvents(
  current: MoleculeEvent[],
  incoming: MoleculeEvent[],
  limit = 150,
) {
  const unique = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming)
    if (!unique.has(event.eventId)) unique.set(event.eventId, event);
  return [...unique.values()]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-limit);
}

export function mergeContexts(current: AssetRef[], incoming: AssetRef[]) {
  const unique = new Map(current.map((asset) => [asset.assetId, asset]));
  for (const asset of incoming)
    if (!unique.has(asset.assetId)) unique.set(asset.assetId, asset);
  return [...unique.values()];
}

export function money(value: number | null | undefined, currency?: string) {
  if (value === null || value === undefined) return "Not provided";
  if (!currency) return `${value.toLocaleString("en-CA")} (currency unknown)`;
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    maximumFractionDigits: 2,
  }).format(value);
}

export function dateLabel(value: string | null | undefined, withTime = false) {
  if (!value) return "Not provided";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not provided";
  return (
    new Intl.DateTimeFormat("en-CA", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
      ...(withTime ? ({ hour: "numeric", minute: "2-digit" } as const) : {}),
    }).format(date) + (withTime ? " UTC" : "")
  );
}

const KNOWN_NAMES: Record<string, string> = {
  openai: "OpenAI",
};

export function humanize(value: string) {
  const text = value.replace(/[_.-]+/g, " ").toLowerCase();
  const known = KNOWN_NAMES[text];
  if (known) return known;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function rangeLabel(min: number, max: number, unit: string) {
  const span = min === max ? String(min) : `${min}–${max}`;
  const word = unit.replace(/[_.-]+/g, " ").toLowerCase().trim();
  const plural =
    max === 1 || !word || /s$/.test(word) || /\d/.test(word)
      ? word
      : `${word}s`;
  return plural ? `${span} ${plural}` : span;
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "Unknown";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  return JSON.stringify(value);
}

export function safeHref(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function supplierAdminUrl(store: string, gid: string) {
  const id = /^gid:\/\/shopify\/DraftOrder\/(\d+)$/.exec(gid)?.[1];
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(store) && id
    ? `https://${store}/admin/draft_orders/${id}`
    : undefined;
}

export function planDelta(
  previous: ProductionPlan | null,
  current: ProductionPlan | null,
) {
  if (
    !previous ||
    !current ||
    previous.planId === current.planId ||
    previous.currency !== current.currency ||
    current.status !== "VALID"
  )
    return null;
  return {
    cost: current.totalCost - previous.totalCost,
    hours:
      previous.estimatedCompletion && current.estimatedCompletion
        ? (Date.parse(current.estimatedCompletion) -
            Date.parse(previous.estimatedCompletion)) /
          3_600_000
        : null,
  };
}

export function graphPositions(plan: ProductionPlan) {
  const ids = new Set(plan.nodes.map((node) => node.nodeId));
  const depth = new Map<string, number>();
  const pending = new Set(ids);
  while (pending.size) {
    let changed = false;
    for (const id of pending) {
      const parents = plan.edges.filter(
        (edge) => edge.toNodeId === id && ids.has(edge.fromNodeId),
      );
      if (parents.some((edge) => !depth.has(edge.fromNodeId))) continue;
      depth.set(
        id,
        parents.length
          ? Math.max(...parents.map((edge) => depth.get(edge.fromNodeId)!)) + 1
          : 0,
      );
      pending.delete(id);
      changed = true;
    }
    if (!changed) {
      const next = Math.max(0, ...depth.values()) + 1;
      for (const id of pending) depth.set(id, next);
      break;
    }
  }
  const rows = new Map<number, string[]>();
  for (const node of plan.nodes) {
    const level = depth.get(node.nodeId) ?? 0;
    rows.set(level, [...(rows.get(level) ?? []), node.nodeId]);
  }
  const maxRows = Math.max(1, ...[...rows.values()].map((row) => row.length));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, nodes] of rows)
    nodes.forEach((id, index) =>
      positions.set(id, {
        x: level * 400,
        y: (index + (maxRows - nodes.length) / 2) * 175,
      }),
    );
  return positions;
}

export const stateLabels: Record<OrderSessionSnapshot["state"], string> = {
  REQUESTED: "Ready for your brief",
  COMPILING_INTENT: "Understanding your request",
  NEEDS_CLARIFICATION: "A few details needed",
  INTENT_COMPILED: "Brief compiled",
  DISCOVERING: "Finding capabilities",
  CANDIDATES_READY: "Candidates found",
  QUOTING: "Collecting merchant quotes",
  QUOTED: "Quotes received",
  SOLVING: "Checking feasibility",
  PLAN_VALIDATED: "Solver validated",
  PLAN_UNSAT: "No feasible plan",
  AWAITING_APPROVAL: "Ready for approval",
  EXECUTING: "Creating commerce actions",
  SKU_CREATED: "Product created",
  SUPPLIER_JOBS_CREATED: "Supplier jobs created",
  CUSTOMER_ORDER_CREATED: "Customer order created",
  COMPLETED: "Execution confirmed",
  AT_RISK: "Plan at risk",
  RECOVERING: "Finding a replacement",
  NEEDS_HUMAN: "Your input is needed",
  FAILED: "Action failed",
  CANCELLED: "Project cancelled",
};

export const processingStates: OrderSessionSnapshot["state"][] = [
  "COMPILING_INTENT",
  "INTENT_COMPILED",
  "DISCOVERING",
  "CANDIDATES_READY",
  "QUOTING",
  "QUOTED",
  "SOLVING",
  "PLAN_VALIDATED",
  "EXECUTING",
  "SKU_CREATED",
  "SUPPLIER_JOBS_CREATED",
  "CUSTOMER_ORDER_CREATED",
  "AT_RISK",
  "RECOVERING",
];

export function canEditBrief(order: OrderSessionSnapshot | null) {
  return (
    !order ||
    [
      "REQUESTED",
      "NEEDS_CLARIFICATION",
      "NEEDS_HUMAN",
      "FAILED",
      "PLAN_UNSAT",
      "AWAITING_APPROVAL",
    ].includes(order.state)
  );
}
