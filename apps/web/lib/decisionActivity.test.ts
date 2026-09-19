import { MoleculeEventSchema } from "@molecule/contracts";
import { describe, expect, it } from "vitest";
import {
  activityPayload,
  activityReason,
  activityTitle,
  visibleActivity,
} from "./decisionActivity";

const event = MoleculeEventSchema.parse({
  eventId: "aabbccdd-1234-4234-9234-123456789abc",
  traceId: "trace",
  orderId: "project",
  eventType: "intent.unsupported",
  ts: "2026-09-19T10:00:00Z",
  severity: "INFO",
  source: "openai",
  payload: { reason: "A production brief is required." },
});

describe("confirmed activity", () => {
  it("surfaces supported reasons without projecting feasibility as execution", () => {
    expect(activityReason(event)).toBe("A production brief is required.");
    expect(activityTitle({ ...event, eventType: "solver.valid" })).toBe(
      "Solver found a feasible plan",
    );
    expect(activityReason({ ...event, eventType: "solver.valid" })).toContain(
      "does not confirm commerce execution",
    );
  });
  it("shows deterministic field resolution explanations without treating model explanations as evidence", () => {
    const resolution = {
      ...event,
      eventType: "reality.claim.conflicted",
      payload: {
        field: "capacity",
        explanation: "Two equally supported source values disagree.",
        value: null,
        status: "conflicted",
      },
    };
    expect(activityReason(resolution)).toBe(resolution.payload.explanation);
    expect(activityPayload(resolution)).toEqual(resolution.payload);
    const model = { ...resolution, eventType: "model.output" };
    expect(activityReason(model)).toBeUndefined();
    expect(activityPayload(model)).not.toHaveProperty("explanation");
  });
  it("filters before limiting and keeps all diagnostics available", () => {
    const noise = { ...event, eventType: "merchant.quote.requested" };
    expect(visibleActivity([event, noise, noise], "decisions", 1)).toEqual([
      event,
    ]);
    expect(visibleActivity([event, noise], "all", 2)).toEqual([noise, event]);
    expect(visibleActivity([event], "all", 0)).toEqual([]);
    expect(
      visibleActivity([{ ...noise, severity: "ERROR" }], "decisions", 1),
    ).toHaveLength(1);
  });
  it("never renders arbitrary model text or nested payloads in diagnostics", () => {
    const payload = activityPayload({
      ...event,
      payload: {
        reason: "Supported reason",
        reasoning: "private",
        chainOfThought: "private",
        response: { content: "private" },
        providerRef: { secret: "private" },
        actions: [
          { actionKey: "action-1", status: "PENDING", reasoning: "private" },
        ],
      },
    });
    expect(payload).toEqual({
      reason: "Supported reason",
      actions: [{ actionKey: "action-1", status: "PENDING" }],
    });
    expect(
      activityReason({ ...event, eventType: "model.output" }),
    ).toBeUndefined();
    expect(activityPayload({ ...event, eventType: "model.output" })).toEqual(
      {},
    );
  });
});
