import { deriveProjectCapabilities } from "@molecule/contracts";
import { RequestProblem } from "./errors.js";
import { makeEvent } from "./events/EventStore.js";
import type { StoredContext } from "./LocalStore.js";
import type { OrderSession } from "./session/OrderSession.js";

export function prepareContextAttachment(
  session: OrderSession,
  context: StoredContext,
) {
  if (!deriveProjectCapabilities(session).canSubmitMessage)
    throw new RequestProblem(
      409,
      "INVALID_TRANSITION",
      "Context cannot be attached in this project state. Start a new project.",
    );
  return {
    session: {
      ...session,
      revision: session.revision + 1,
      updatedAt: new Date().toISOString(),
    },
    event: makeEvent({
      traceId: session.traceId,
      orderId: session.orderId,
      eventType: "context.attached",
      source: "ui",
      payload: {
        contextId: context.asset.assetId,
        name: context.asset.name,
      },
    }),
  };
}
