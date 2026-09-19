import {
  ApiErrorSchema,
  ContextReceiptSchema,
  ContextUploadSchema,
  DesktopActionSchema,
  DesktopResultSchema,
  MarketplaceSnapshotSchema,
  MAX_CONTEXT_BYTES,
  OrderSessionSnapshotSchema,
  type AssetRef,
  type ChaosRequest,
  type CompileIntentRequest,
  type OrderSessionSnapshot,
} from "@molecule/contracts";

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly traceId?: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export async function request(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  try {
    const response = await fetch(path, {
      ...init,
      signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = ApiErrorSchema.safeParse(body);
      throw new RequestError(
        error.success
          ? error.data.message
          : response.status === 404
            ? "This project or service is unavailable. Refresh or start a new project."
            : response.status === 409
              ? "The project changed. Refresh before trying this action again."
              : response.status === 400
                ? "The server could not accept this request. Check your input or supported actions."
                : `The service could not complete this request (${response.status}). Refresh to check its outcome.`,
        response.status,
        error.success ? error.data.code : "REQUEST_FAILED",
        error.success ? error.data.traceId : undefined,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (signal.aborted)
      throw new RequestError(
        "The request timed out or was interrupted. Refresh to check the server outcome before retrying.",
        0,
        "INTERRUPTED",
      );
    throw new RequestError(
      "Cannot reach the service. Check your connection and refresh.",
      0,
      "NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseSnapshot(value: unknown): OrderSessionSnapshot {
  const result = OrderSessionSnapshotSchema.safeParse(value);
  if (!result.success)
    throw new RequestError(
      "The service returned an incompatible project. Refresh or contact the operator.",
      502,
      "INVALID_RESPONSE",
    );
  return result.data;
}

export function actionHeaders(traceId: string, actionKey: string) {
  return {
    "x-trace-id": traceId,
    "x-action-id": actionKey,
    "x-action-key": actionKey,
  };
}

export async function createOrder(actionKey: string) {
  return parseSnapshot(
    await request("/api/orders", {
      method: "POST",
      headers: actionHeaders(actionKey, actionKey),
      body: "{}",
    }),
  );
}

export async function getOrder(orderId: string, signal?: AbortSignal) {
  return parseSnapshot(
    await request(`/api/orders/${encodeURIComponent(orderId)}`, { signal }),
  );
}

export async function getMarketplace(signal?: AbortSignal) {
  const result = MarketplaceSnapshotSchema.safeParse(
    await request("/api/marketplace", { signal }),
  );
  if (!result.success)
    throw new RequestError(
      "Marketplace data is incompatible. Ask the operator to check the read model.",
      502,
      "INVALID_RESPONSE",
    );
  return result.data;
}

export async function getDemoMode(signal?: AbortSignal): Promise<boolean> {
  const config = await request("/api/desktop/config", { signal });
  if (
    typeof config !== "object" ||
    config === null ||
    !("demoMode" in config) ||
    typeof config.demoMode !== "boolean"
  )
    throw new RequestError(
      "Demo controls are unavailable.",
      502,
      "INVALID_RESPONSE",
    );
  return config.demoMode;
}

export async function submitMessage(
  order: OrderSessionSnapshot,
  text: string,
  actionKey: string,
  assets: AssetRef[] = [],
  correction?: CompileIntentRequest["correction"],
) {
  return parseSnapshot(
    await request(`/api/orders/${encodeURIComponent(order.orderId)}/messages`, {
      method: "POST",
      headers: actionHeaders(order.traceId, actionKey),
      body: JSON.stringify({
        text,
        assets,
        locale: navigator.language || "en-CA",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        correction,
      }),
    }),
  );
}

export async function approvePlan(order: OrderSessionSnapshot) {
  const plan = order.activePlan;
  if (
    !plan ||
    plan.status !== "VALID" ||
    plan.intentVersion !== order.intentVersion
  )
    throw new Error(
      "Refresh the project to review a current, solver-validated plan.",
    );
  return parseSnapshot(
    await request(`/api/orders/${encodeURIComponent(order.orderId)}/approve`, {
      method: "POST",
      headers: actionHeaders(
        order.traceId,
        `approve:${order.orderId}:${plan.planId}`,
      ),
      body: JSON.stringify({
        planId: plan.planId,
        intentVersion: plan.intentVersion,
      }),
    }),
  );
}

export async function triggerChaos(
  order: OrderSessionSnapshot,
  merchantId: string,
  scenario: ChaosRequest["scenario"],
  actionKey: string,
) {
  return parseSnapshot(
    await request("/api/chaos", {
      method: "POST",
      headers: actionHeaders(order.traceId, actionKey),
      body: JSON.stringify({
        scenario,
        orderId: order.orderId,
        merchantId,
        actionId: actionKey,
      }),
    }),
  );
}

export function fileMetadata(file: File, actionId: string) {
  const mimeType =
    file.type ||
    (file.name.toLowerCase().endsWith(".csv")
      ? "text/csv"
      : file.name.toLowerCase().endsWith(".txt")
        ? "text/plain"
        : "");
  const metadata = ContextUploadSchema.safeParse({
    actionId,
    name: file.name,
    mimeType,
  });
  if (!metadata.success || /[\\/\x00-\x1f]/u.test(file.name))
    throw new Error(
      "Use a PNG, JPEG, PDF, CSV, text or JSON file with a valid filename.",
    );
  if (!file.size || file.size > MAX_CONTEXT_BYTES)
    throw new Error("Choose a nonempty file up to 10 MB.");
  return metadata.data;
}

export async function uploadContext(
  order: OrderSessionSnapshot,
  file: File,
  actionKey: string,
) {
  const metadata = fileMetadata(file, actionKey);
  const receipt = ContextReceiptSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(order.orderId)}/context`,
      {
        method: "POST",
        headers: {
          ...actionHeaders(order.traceId, actionKey),
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(metadata.name),
          "x-file-type": metadata.mimeType,
        },
        body: file,
      },
    ),
  );
  const action = DesktopActionSchema.parse({
    actionId: `attach:${receipt.contextId}`,
    command: { name: "attach_context", args: { contextId: receipt.contextId } },
  });
  return DesktopResultSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(order.orderId)}/actions`,
      {
        method: "POST",
        headers: actionHeaders(order.traceId, action.actionId),
        body: JSON.stringify(action),
      },
    ),
  );
}

export async function getContexts(orderId: string, signal?: AbortSignal) {
  return DesktopResultSchema.parse(
    await request(`/api/projects/${encodeURIComponent(orderId)}`, { signal }),
  );
}
