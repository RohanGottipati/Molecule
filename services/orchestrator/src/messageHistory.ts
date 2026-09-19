import {
  MessageHistorySchema,
  MessageOutcomeSchema,
  ProductionMessageSchema,
} from "@molecule/contracts";
import type { EventStore } from "./events/EventStore.js";

export async function readMessageHistory(
  events: EventStore,
  orderId: string,
  afterCursor: number,
  limit: number,
) {
  const entries = await events.list(orderId, 0);
  const outcomes = new Map<
    string,
    ReturnType<typeof MessageOutcomeSchema.parse>
  >();
  for (const { event } of entries) {
    if (event.eventType !== "message.outcome") continue;
    const outcome = MessageOutcomeSchema.safeParse(event.payload);
    if (outcome.success) outcomes.set(outcome.data.messageId, outcome.data);
  }
  const messages = entries.flatMap(({ cursor, event }) => {
    if (cursor <= afterCursor) return [];
    const message = ProductionMessageSchema.safeParse(
      event.payload.productionMessage,
    );
    if (!message.success || message.data.orderId !== orderId) return [];
    return [
      {
        ...message.data,
        cursor,
        outcome: outcomes.get(message.data.messageId) ?? {
          messageId: message.data.messageId,
          status: "pending" as const,
          resultRevision: null,
          reason: null,
        },
      },
    ];
  });
  return MessageHistorySchema.parse({
    messages: messages.slice(0, limit),
    nextCursor: messages.length > limit ? messages[limit - 1]!.cursor : null,
  });
}
