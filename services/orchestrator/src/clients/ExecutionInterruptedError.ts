import type { ExecutionReceipt } from "@molecule/contracts";

export class ExecutionInterruptedError extends Error {
  constructor(readonly receipt: ExecutionReceipt) {
    super(
      "Commerce records exist, but supplier acceptance requires operator reconciliation.",
    );
    this.name = "ExecutionInterruptedError";
  }
}
