import { randomUUID } from "node:crypto";

import type {
  CandidateCapability,
  ExecutionReceipt,
  OrderSessionSnapshot,
  OrderSessionState,
  ProductIntentDraft,
  ProductionPlan,
  QuoteResponse,
} from "@molecule/contracts";

export interface OrderSession {
  orderId: string;
  traceId: string;
  state: OrderSessionState;
  revision: number;
  intentVersion: number;
  planGeneration: number;
  intent: ProductIntentDraft | null;
  candidates: CandidateCapability[];
  quotes: QuoteResponse[];
  activePlan: ProductionPlan | null;
  executionReceipt: ExecutionReceipt | null;
  lastErrorCode: string | null;
  eventCursor: number;
  createdAt: string;
  updatedAt: string;
}

export function createOrderSession(now = new Date()): OrderSession {
  const timestamp = now.toISOString();
  return {
    orderId: randomUUID(),
    traceId: randomUUID(),
    state: "REQUESTED",
    revision: 0,
    intentVersion: 0,
    planGeneration: 0,
    intent: null,
    candidates: [],
    quotes: [],
    activePlan: null,
    executionReceipt: null,
    lastErrorCode: null,
    eventCursor: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function toSnapshot(session: OrderSession): OrderSessionSnapshot {
  return structuredClone(session);
}
