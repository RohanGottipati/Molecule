import type { OrderSession } from "./OrderSession.js";

export function isStale(
  session: OrderSession,
  result: { intentVersion: number; planGeneration: number },
): boolean {
  return (
    result.intentVersion !== session.intentVersion ||
    result.planGeneration < session.planGeneration
  );
}
