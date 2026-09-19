import type { MessageHistory } from "@molecule/contracts";
import {
  getCapabilities,
  getContexts,
  getMessages,
  getOrder,
  RequestError,
} from "./api";
import { mergeSnapshot } from "./workspace";

export async function readProject(
  orderId: string,
  pages = 1,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const boundedSignal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(15_000),
    ...(signal ? [signal] : []),
  ]);
  const history = async () => {
    const messages: MessageHistory["messages"] = [];
    let cursor = 0;
    let nextCursor: number | null = null;
    for (let page = 0; page < pages; page++) {
      const result = await getMessages(orderId, cursor, boundedSignal);
      messages.push(...result.messages);
      nextCursor = result.nextCursor;
      if (nextCursor === null) break;
      cursor = nextCursor;
    }
    return { messages, nextCursor };
  };
  try {
    const [snapshot, attached, capabilities, messages] = await Promise.all([
      getOrder(orderId, boundedSignal),
      getContexts(orderId, boundedSignal),
      getCapabilities(orderId, boundedSignal),
      history(),
    ]);
    if (snapshot.orderId !== orderId || attached.project.orderId !== orderId)
      throw new RequestError(
        "The response belongs to another project.",
        502,
        "INVALID_RESPONSE",
      );
    const order =
      mergeSnapshot(snapshot, attached.project, orderId) ?? snapshot;
    if (
      capabilities.revision !== order.revision ||
      attached.project.revision !== snapshot.revision
    )
      throw new RequestError(
        "The project changed during refresh. Synchronizing again.",
        409,
        "STALE_VERSION",
      );
    return {
      order,
      contexts: attached.contexts,
      capabilities,
      history: messages,
    };
  } finally {
    controller.abort();
  }
}
