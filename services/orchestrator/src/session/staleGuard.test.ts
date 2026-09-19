import { describe, expect, it } from "vitest";

import { createOrderSession } from "./OrderSession.js";
import { isStale } from "./staleGuard.js";

describe("stale guard", () => {
  it("rejects older versions and generations", () => {
    const session = {
      ...createOrderSession(),
      intentVersion: 2,
      planGeneration: 4,
    };
    expect(isStale(session, { intentVersion: 1, planGeneration: 4 })).toBe(
      true,
    );
    expect(isStale(session, { intentVersion: 2, planGeneration: 3 })).toBe(
      true,
    );
    expect(isStale(session, { intentVersion: 2, planGeneration: 4 })).toBe(
      false,
    );
  });
});
