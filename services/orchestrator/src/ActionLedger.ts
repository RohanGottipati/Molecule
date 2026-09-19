import { createHash } from "node:crypto";
import { z } from "zod";
import { SessionConflictError } from "./repositories.js";

export const ActionReceiptSchema = z.object({
  key: z.string(),
  fingerprint: z.string(),
  state: z.enum(["pending", "complete", "failed"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
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
      await this.save({
        key,
        fingerprint,
        state: "failed",
        error: error instanceof Error ? error.message : "Action failed",
      });
      throw error;
    }
  }
}
