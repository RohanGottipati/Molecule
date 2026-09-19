import { OrderSessionStateSchema } from "@molecule/contracts";
import { describe, expect, it } from "vitest";

import { createOrderSession } from "./OrderSession.js";
import { InvalidTransitionError, transition } from "./transitions.js";

describe("order session transitions", () => {
  it("rejects skipping intent compilation", () => {
    expect(() => transition(createOrderSession(), "PLAN_VALIDATED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("rejects execution without a current valid plan", () => {
    const session = {
      ...createOrderSession(),
      state: "AWAITING_APPROVAL" as const,
    };
    expect(() => transition(session, "EXECUTING")).toThrow(
      InvalidTransitionError,
    );
  });

  it.each(OrderSessionStateSchema.options)(
    "rejects the undeclared %s self-transition",
    (state) => {
      const session = { ...createOrderSession(), state };
      expect(() => transition(session, state)).toThrow(InvalidTransitionError);
    },
  );
});
