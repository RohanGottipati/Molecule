import {
  DesktopCommandSchema,
  type DesktopCommand,
  type DesktopResult,
} from "@molecule/contracts";

export class ToolDispatcher {
  private readonly calls = new Map<
    string,
    { fingerprint: string; result: Promise<DesktopResult> }
  >();
  constructor(
    private readonly execute: (
      command: DesktopCommand,
      actionId: string,
    ) => Promise<DesktopResult>,
  ) {}
  run(callId: string, name: string, argumentsJson: string) {
    const command = DesktopCommandSchema.parse({
      name,
      args: JSON.parse(argumentsJson),
    });
    const fingerprint = JSON.stringify(command);
    const existing = this.calls.get(callId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("Tool call ID reused");
      return existing.result;
    }
    const result = this.execute(command, `voice:${callId}`);
    this.calls.set(callId, { fingerprint, result });
    void result
      .finally(() => {
        if (this.calls.size > 500)
          this.calls.delete(this.calls.keys().next().value!);
      })
      .catch(() => undefined);
    return result;
  }
}
