import { describe, expect, it } from "vitest";

import {
  InMemorySessionRepository,
  SessionConflictError,
} from "./repositories.js";
import { createOrderSession } from "./session/OrderSession.js";

describe("session compare-and-swap", () => {
  it("rejects a stale concurrent state write", async () => {
    const repository = new InMemorySessionRepository();
    const original = createOrderSession();
    await repository.create(original);
    const first = { ...original, revision: 1 };
    const stale = { ...original, revision: 1, state: "FAILED" as const };
    await repository.save(first, 0);
    await expect(repository.save(stale, 0)).rejects.toBeInstanceOf(
      SessionConflictError,
    );
    expect((await repository.get(original.orderId))?.state).toBe("REQUESTED");
  });
});
