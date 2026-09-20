import { describe, expect, it } from "vitest";
import {
  deriveProjectCapabilities,
  OrderSessionSnapshotSchema,
  ProjectListQuerySchema,
  MessageHistoryQuerySchema,
  DesktopActionSchema,
} from "./index.js";

const snapshot = OrderSessionSnapshotSchema.parse({
  orderId: "order",
  traceId: "trace",
  state: "NEEDS_HUMAN",
  revision: 4,
  intentVersion: 1,
  planGeneration: 1,
  intent: null,
  candidates: [],
  quotes: [],
  activePlan: null,
  executionReceipt: null,
  lastErrorCode: null,
  eventCursor: 10,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("shared capabilities and bounded read models", () => {
  it("distinguishes planning attention from uncertain commerce effects", () => {
    expect(deriveProjectCapabilities(snapshot)).toMatchObject({
      canSubmitMessage: true,
      canCancelPlanning: true,
      requiresOperator: false,
    });
    expect(deriveProjectCapabilities(snapshot, true)).toMatchObject({
      canSubmitMessage: false,
      canCancelPlanning: false,
      canApprove: false,
      requiresOperator: true,
    });
    expect(
      deriveProjectCapabilities({
        ...snapshot,
        lastErrorCode: "EXECUTION_UNCERTAIN",
      }).requiresOperator,
    ).toBe(true);
  });

  it("keeps terminal and execution states protected", () => {
    for (const state of [
      "CANCELLED",
      "COMPLETED",
      "EXECUTING",
      "RECOVERING",
    ] as const) {
      expect(deriveProjectCapabilities({ ...snapshot, state })).toMatchObject({
        canSubmitMessage: false,
        canCancelPlanning: false,
        canApprove: false,
      });
    }
  });

  it("bounds queries and accepts optional desktop text/revision without changing old actions", () => {
    expect(ProjectListQuerySchema.parse({})).toEqual({ limit: 20, search: "" });
    expect(MessageHistoryQuerySchema.parse({})).toEqual({
      afterCursor: 0,
      limit: 50,
    });
    expect(ProjectListQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(
      MessageHistoryQuerySchema.safeParse({ afterCursor: -1 }).success,
    ).toBe(false);
    const action = {
      actionId: "recompile",
      command: { name: "request_recompile", args: {} },
    };
    expect(DesktopActionSchema.safeParse(action).success).toBe(true);
    expect(
      DesktopActionSchema.parse({
        ...action,
        originalText: "Please recompile\n",
        expectedRevision: 4,
      }),
    ).toMatchObject({
      originalText: "Please recompile\n",
      expectedRevision: 4,
    });
  });
});
