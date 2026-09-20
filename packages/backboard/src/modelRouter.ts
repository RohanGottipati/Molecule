import { MoleculeEventSchema, type MoleculeEvent } from "@molecule/contracts";

import type { BackboardAdapter } from "./BackboardAdapter.js";
import type { BackboardModel } from "./types.js";

/**
 * B6 item 76 lanes. A lane is a routing target, not a model name: the same
 * discovered/pinned model may satisfy more than one lane.
 */
export const LANE_IDS = [
  "FAST_OPS",
  "BULK_EXTRACTION",
  "HIGH_REASONING",
  "VISION_OPTIONAL",
] as const;
export type LaneId = (typeof LANE_IDS)[number];

/**
 * B6 item 77 routing inputs. Each descriptor maps to exactly one lane so
 * routing stays deterministic and auditable — never chosen to "maximize
 * number of models used" (item 78).
 */
export type TaskDescriptor =
  | { kind: "low_stakes_inventory" }
  | { kind: "policy_conflict" }
  | { kind: "deadline_guarantee" }
  | { kind: "visual_merchant_artifact" }
  | { kind: "bulk_extraction" };

export interface ModelSelection {
  lane: LaneId;
  modelId: string;
  reason: string;
}

export interface SelectModelInput {
  task: TaskDescriptor;
  traceId: string;
  merchantId?: string;
  orderId?: string;
}

export interface SelectModelOutput {
  selection: ModelSelection;
  /** B6 item 78: the agent.model.selected MoleculeEvent, already contract-validated. */
  event: MoleculeEvent;
}

export interface ModelRouter {
  /** B6 item 75: discovers Backboard's tested models once and caches the result. */
  discoverModels(): Promise<BackboardModel[]>;
  /**
   * B6 item 76: pins a specific tested model to a lane (e.g. at demo
   * freeze), overriding discovery for that lane while discovery metadata
   * itself stays cached and available.
   */
  pinLane(lane: LaneId, modelId: string): void;
  /** B6 items 77-78: routes a task descriptor to a lane/model and emits the selection event. */
  selectModel(input: SelectModelInput): Promise<SelectModelOutput>;
}

function laneForTask(task: TaskDescriptor): { lane: LaneId; reason: string } {
  switch (task.kind) {
    case "low_stakes_inventory":
      return {
        lane: "FAST_OPS",
        reason: "Low-stakes inventory response routed to the fast-ops lane.",
      };
    case "policy_conflict":
      return {
        lane: "HIGH_REASONING",
        reason: "Policy conflict routed to the high-reasoning lane.",
      };
    case "deadline_guarantee":
      return {
        lane: "HIGH_REASONING",
        reason:
          "High-value deadline guarantee routed to the high-reasoning lane.",
      };
    case "visual_merchant_artifact":
      return {
        lane: "VISION_OPTIONAL",
        reason: "Visual merchant artifact routed to the vision-optional lane.",
      };
    case "bulk_extraction":
      return {
        lane: "BULK_EXTRACTION",
        reason: "Bulk extraction routed to the bulk-extraction lane.",
      };
  }
}

/**
 * B6 item 75 discovery filters, one predicate per lane. VISION_OPTIONAL is
 * the only lane that requires supportsVision; the others don't need it.
 */
const LANE_REQUIREMENTS: Record<LaneId, (model: BackboardModel) => boolean> = {
  FAST_OPS: (model) => model.supportsTools && model.supportsJsonOutput,
  BULK_EXTRACTION: (model) =>
    model.supportsJsonOutput && model.contextWindow >= 64_000,
  HIGH_REASONING: (model) =>
    model.supportsTools && model.supportsThinking && model.supportsJsonOutput,
  VISION_OPTIONAL: (model) => model.supportsVision,
};

export function createModelRouter(
  adapter: Pick<BackboardAdapter, "listModels">,
  options?: { emitEvent?: (event: MoleculeEvent) => void },
): ModelRouter {
  let cachedModels: Promise<BackboardModel[]> | undefined;
  const pinnedByLane = new Map<LaneId, string>();

  async function discoverModels(): Promise<BackboardModel[]> {
    if (!cachedModels) {
      cachedModels = adapter.listModels().catch((error: unknown) => {
        cachedModels = undefined;
        throw error;
      });
    }
    return cachedModels;
  }

  function pinLane(lane: LaneId, modelId: string): void {
    pinnedByLane.set(lane, modelId);
  }

  async function resolveModelForLane(lane: LaneId): Promise<string> {
    const pinned = pinnedByLane.get(lane);
    if (pinned) {
      return pinned;
    }
    const models = await discoverModels();
    const candidate = models.find((model) => LANE_REQUIREMENTS[lane](model));
    if (!candidate) {
      throw new Error(
        `No discovered Backboard model satisfies lane ${lane}; pin one explicitly.`,
      );
    }
    return candidate.modelId;
  }

  async function selectModel(
    input: SelectModelInput,
  ): Promise<SelectModelOutput> {
    const { lane, reason } = laneForTask(input.task);
    const modelId = await resolveModelForLane(lane);
    const selection: ModelSelection = { lane, modelId, reason };

    const event = MoleculeEventSchema.parse({
      eventId: crypto.randomUUID(),
      traceId: input.traceId,
      orderId: input.orderId,
      merchantId: input.merchantId,
      eventType: "agent.model.selected",
      ts: new Date().toISOString(),
      severity: "INFO",
      source: "backboard",
      payload: { lane, modelId, reason },
    });

    options?.emitEvent?.(event);
    return { selection, event };
  }

  return { discoverModels, pinLane, selectModel };
}
