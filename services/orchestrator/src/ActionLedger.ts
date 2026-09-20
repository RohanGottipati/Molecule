import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ApiErrorSchema,
  ActionStatusSchema,
  OrderSessionSnapshotSchema,
  DesktopResultSchema,
  type ActionStatusQuery,
} from "@molecule/contracts";
import {
  SessionConflictError,
  SupersededSubmissionError,
} from "./repositories.js";
import { apiFailure } from "./errors.js";

export const ActionReceiptSchema = z.object({
  key: z.string(),
  fingerprint: z.string(),
  state: z.enum(["pending", "complete", "failed"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
  publicError: ApiErrorSchema.optional(),
  superseded: z.boolean().optional(),
});
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;
export interface ReceiptStore {
  getReceipt(key: string): Promise<ActionReceipt | undefined>;
  saveReceipt(receipt: ActionReceipt): Promise<void>;
  claimReceipt?(receipt: ActionReceipt): Promise<boolean>;
}

export class ActionLedger {
  private readonly running = new Map<
    string,
    { fingerprint: string; promise: Promise<unknown> }
  >();
  private readonly memory = new Map<string, ActionReceipt>();
  constructor(private readonly store?: ReceiptStore) {}

  async status(orderId: string, query: ActionStatusQuery) {
    const key =
      query.kind === "desktop"
        ? `${orderId}:${query.key}`
        : `${orderId}:${query.kind}:${query.key}`;
    const receipt = this.store
      ? await this.store.getReceipt(key)
      : this.memory.get(key);
    const direct = OrderSessionSnapshotSchema.safeParse(receipt?.result);
    const desktop = DesktopResultSchema.safeParse(receipt?.result);
    const result = direct.success
      ? direct.data
      : desktop.success
        ? desktop.data.project
        : null;
    return ActionStatusSchema.parse({
      orderId,
      ...query,
      status: !receipt
        ? "unknown"
        : receipt.state === "complete"
          ? "succeeded"
          : receipt.superseded
            ? "superseded"
            : receipt.state,
      resultRevision: result?.orderId === orderId ? result.revision : null,
      resultState: result?.orderId === orderId ? result.state : null,
      error:
        receipt?.state === "failed"
          ? (receipt.publicError ?? apiFailure(new Error(), orderId).body)
          : null,
      automaticRetryAllowed: false,
    });
  }

  async run<T>(
    key: string,
    input: unknown,
    parse: (value: unknown) => T,
    operation: () => Promise<NoInfer<T>>,
  ): Promise<T> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const pending = this.running.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new SessionConflictError(
          "Action ID reused with different arguments",
        );
      return parse(await pending.promise);
    }
    const promise = this.execute(key, fingerprint, operation);
    this.running.set(key, { fingerprint, promise });
    try {
      return parse(await promise);
    } finally {
      this.running.delete(key);
    }
  }

  private async save(receipt: ActionReceipt) {
    if (this.store) await this.store.saveReceipt(receipt);
    else this.memory.set(receipt.key, receipt);
  }

  private async execute<T>(
    key: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T | unknown> {
    const prior = this.store
      ? await this.store.getReceipt(key)
      : this.memory.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new SessionConflictError(
          "Action ID reused with different arguments",
        );
      if (prior.state === "complete") return prior.result;
      if (prior.superseded) throw new SupersededSubmissionError();
      throw new SessionConflictError(
        prior.error ??
          "Action outcome unknown after restart. Refresh the project before taking another action.",
      );
    }
    const receipt: ActionReceipt = { key, fingerprint, state: "pending" };
    if (this.store?.claimReceipt) {
      if (!(await this.store.claimReceipt(receipt)))
        throw new SessionConflictError(
          "Action is already in progress. Refresh the project.",
        );
    } else await this.save(receipt);
    try {
      const result = await operation();
      await this.save({ key, fingerprint, state: "complete", result });
      return result;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error("Action failed");
      await this.save({
        key,
        fingerprint,
        state: "failed",
        publicError: apiFailure(normalized, key.slice(0, 160)).body,
        superseded: error instanceof SupersededSubmissionError,
      });
      throw error;
    }
  }
}
