import {
  OrderSessionSnapshotSchema,
  type OrderSessionSnapshot,
} from "@molecule/contracts";

export const API_URL =
  process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:3001";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "message" in body
        ? String(body.message)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function snapshot(value: unknown): OrderSessionSnapshot {
  return OrderSessionSnapshotSchema.parse(value);
}

export async function createOrder(): Promise<OrderSessionSnapshot> {
  return snapshot(await json("/api/orders", { method: "POST" }));
}

export async function getOrder(orderId: string): Promise<OrderSessionSnapshot> {
  return snapshot(await json(`/api/orders/${orderId}`));
}

export async function submitMessage(
  orderId: string,
  text: string,
  correction?: {
    kind:
      | "constraint"
      | "preference"
      | "quantity"
      | "deadline"
      | "budget"
      | "other";
    text: string;
  },
): Promise<OrderSessionSnapshot> {
  return snapshot(
    await json(`/api/orders/${orderId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text,
        locale: navigator.language || "en-CA",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        correction,
      }),
    }),
  );
}

export async function approvePlan(
  orderId: string,
  planId: string,
  intentVersion: number,
): Promise<OrderSessionSnapshot> {
  return snapshot(
    await json(`/api/orders/${orderId}/approve`, {
      method: "POST",
      body: JSON.stringify({ planId, intentVersion }),
    }),
  );
}

export async function triggerSupplierOffline(
  orderId: string,
  merchantId: string,
): Promise<OrderSessionSnapshot> {
  return snapshot(
    await json("/api/chaos", {
      method: "POST",
      body: JSON.stringify({
        scenario: "supplier_offline",
        orderId,
        merchantId,
      }),
    }),
  );
}

export async function realtimeSecret(orderId: string): Promise<string> {
  const result = await json<{ value: string }>(
    `/api/orders/${orderId}/realtime/client-secret`,
    { method: "POST" },
  );
  if (!result.value.startsWith("ek_"))
    throw new Error("Invalid realtime credential");
  return result.value;
}
