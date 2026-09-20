import {
  ActionStatusSchema,
  MessageHistorySchema,
  MessageSubmissionSchema,
  OrderSessionSnapshotSchema,
  ProductIntentSchema,
  ProductionPlanSchema,
  deriveProjectCapabilities,
} from "@molecule/contracts";
import type { PendingAction } from "./persistence";

export const snapshot = OrderSessionSnapshotSchema.parse({
  orderId: "project-one",
  traceId: "trace-one",
  state: "AWAITING_APPROVAL",
  revision: 8,
  intentVersion: 2,
  planGeneration: 3,
  eventCursor: 12,
  intent: ProductIntentSchema.parse({
    intentId: "aabbccdd-1234-4234-9234-123456789abc",
    version: 2,
    quantity: 20,
    deadline: "2026-10-01T00:00:00Z",
    currency: "CAD",
    budgetMax: 1000,
    desiredOutputs: [{ outputId: "hoodie", name: "Hoodie", quantity: 20 }],
    transformations: [],
    hardConstraints: [],
    softPreferences: [],
  }),
  candidates: [],
  quotes: [],
  activePlan: ProductionPlanSchema.parse({
    planId: "plan-one",
    orderId: "project-one",
    intentVersion: 2,
    status: "VALID",
    nodes: [],
    edges: [],
    totalCost: 800,
    currency: "CAD",
    riskScore: 0,
    constraintResults: [],
  }),
  executionReceipt: null,
  lastErrorCode: null,
  createdAt: "2026-09-19T10:00:00Z",
  updatedAt: "2026-09-19T10:00:00Z",
});
export const capabilities = {
  orderId: snapshot.orderId,
  revision: snapshot.revision,
  capabilities: deriveProjectCapabilities(snapshot),
};
export const pending: PendingAction = {
  key: "message:one",
  orderId: snapshot.orderId,
  traceId: snapshot.traceId,
  kind: "message",
  status: "unknown",
  payload: MessageSubmissionSchema.parse({
    text: "No polyester",
    expectedRevision: snapshot.revision,
    assets: [{ assetId: "logo-one", name: "Logo", checksum: "original" }],
    correction: { kind: "other", text: "No polyester" },
  }),
};
export const status = ActionStatusSchema.parse({
  orderId: snapshot.orderId,
  key: pending.key,
  kind: "message",
  status: "unknown",
  resultRevision: null,
  resultState: null,
  error: null,
  automaticRetryAllowed: false,
});
export const history = MessageHistorySchema.parse({
  messages: [
    {
      messageId: pending.key,
      orderId: snapshot.orderId,
      source: "web",
      text: "No polyester",
      assets: pending.payload!.assets,
      acceptedAt: "2026-09-19T10:01:00Z",
      acceptedRevision: 9,
      planGeneration: 4,
      cursor: 1,
      outcome: {
        messageId: pending.key,
        status: "pending",
        resultRevision: null,
        reason: null,
      },
    },
  ],
  nextCursor: null,
});
