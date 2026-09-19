import {
  ExecutionReceiptSchema,
  type ExecutionActionReceipt,
  type ExecutionReceipt,
  type ProductionPlan,
} from "@molecule/contracts";
import { z } from "zod";
import {
  MockShopifyEffects,
  RealShopifyEffects,
  type MockShopifyOptions,
  type RealShopifyEffectsOptions,
  type ShopifyEffects,
} from "./effects.js";
import {
  eventFor,
  type OrderJournal,
  type ShopifyActionRepository,
} from "./repository.js";
import {
  actionKey,
  digest,
  ShopifyError,
  validatedPlan,
  type ActionRecord,
  type ShopifyClient,
  type ShopifyEffect,
  type ShopifyOrderState,
  type ShopifyResource,
} from "./types.js";

export interface ShopifyClientOptions {
  repository: ShopifyActionRepository;
  jobInstructions?: (
    plan: ProductionPlan,
    node: ProductionPlan["nodes"][number],
  ) => Record<string, string>;
}

class DurableShopifyClient implements ShopifyClient {
  constructor(
    protected readonly repository: ShopifyActionRepository,
    protected readonly effects: ShopifyEffects,
    private readonly instructions?: ShopifyClientOptions["jobInstructions"],
  ) {}

  async commit(
    input: ProductionPlan,
    traceId: string,
  ): Promise<ExecutionReceipt> {
    const plan = validatedPlan(input, traceId);
    if (this.effects instanceof RealShopifyEffects)
      this.effects.assertEnabled();
    for (const node of plan.nodes) {
      const domain = this.effects.supplierDomain(node.merchantId);
      if (node.catalogVersion && this.effects instanceof RealShopifyEffects) {
        if (!node.selectedItem || node.selectedItem.shopDomain !== domain ||
            (node.selectedItem.itemKind === "physical" && !node.selectedItem.variantGid))
          throw new ShopifyError("CATALOG_VARIANT_NOT_MAPPED");
      }
    }
    const instructions = new Map<string, string>();
    for (const node of plan.nodes) {
      const parsed = z
        .record(z.string().max(100), z.string().max(2000))
        .safeParse(this.instructions?.(plan, node) ?? {});
      if (!parsed.success) throw new ShopifyError("INVALID_JOB_INSTRUCTIONS");
      const value = JSON.stringify(
        Object.fromEntries(
          Object.entries(parsed.data).sort(([a], [b]) => a.localeCompare(b)),
        ),
      );
      if (value.length > 5000)
        throw new ShopifyError("INVALID_JOB_INSTRUCTIONS");
      instructions.set(node.nodeId, value);
    }
    const fingerprint = digest([plan, [...instructions.entries()]]);
    return this.repository.withOrder(plan.orderId, async (journal) => {
      const state = (await journal.load()) ?? {
        version: 1,
        mode: this.effects.mode,
        binding: this.effects.binding,
        orderId: plan.orderId,
        plans: {},
        actions: {},
        mockResources: {},
      };
      this.checkState(state);
      const key = digest(plan.planId);
      const previousPlan = state.targetPlanId
        ? state.plans[digest(state.targetPlanId)]
        : undefined;
      const existing = state.plans[key];
      if (existing && existing.fingerprint !== fingerprint)
        throw new ShopifyError("PLAN_ID_REUSED");
      if (
        existing?.superseded ||
        (existing &&
          previousPlan &&
          previousPlan.plan.planId !== plan.planId) ||
        this.hasCancellation(state, plan.planId)
      )
        throw new ShopifyError("PLAN_SUPERSEDED");
      if (previousPlan && previousPlan.plan.intentVersion > plan.intentVersion)
        throw new ShopifyError("STALE_PLAN");
      if (previousPlan && previousPlan.plan.planId !== plan.planId) {
        if (
          Object.values(state.actions).some(
            (action) => action.receipt.status === "PENDING",
          )
        ) {
          throw new ShopifyError("PREVIOUS_EXECUTION_PENDING");
        }
        if (
          Object.values(state.plans).some(
            (old) =>
              !old.superseded && this.hasCancellation(state, old.plan.planId),
          )
        )
          throw new ShopifyError("PLAN_CANCELLATION_INCOMPLETE");
      }
      if (!existing)
        state.plans[key] = {
          plan,
          fingerprint,
          superseded: false,
          reusedJobs: {},
        };
      state.targetPlanId = plan.planId;
      await journal.save(
        state,
        eventFor(
          traceId,
          "shopify.execution.started",
          { mode: state.mode },
          plan.orderId,
          plan.planId,
        ),
      );
      const receipt: ExecutionReceipt = {
        orderId: plan.orderId,
        planId: plan.planId,
        intentVersion: plan.intentVersion,
        actions: (existing?.receipt?.actions ?? []).filter(
          (action) => action.kind === "SUPERSEDE_SUPPLIER_JOB",
        ),
        supplierJobs: [],
      };
      const finish = async () => {
        const parsed = ExecutionReceiptSchema.parse(receipt);
        state.plans[key]!.receipt = parsed;
        await journal.save(
          state,
          eventFor(
            traceId,
            parsed.actions.every(
              (action) =>
                action.status === "SUCCEEDED" ||
                action.status === "COMPENSATED",
            )
              ? "shopify.execution.completed"
              : "shopify.execution.incomplete",
            { mode: state.mode, actions: parsed.actions },
            plan.orderId,
            plan.planId,
          ),
        );
        return parsed;
      };

      const reusable = state.plans[key]!.reusedJobs;
      for (const old of Object.values(state.plans)) {
        if (old.plan.planId === plan.planId || old.superseded) continue;
        for (const node of old.plan.nodes) {
          const previous = this.previousJob(state, old, node.nodeId);
          if (!previous?.resource || previous.receipt.status !== "SUCCEEDED")
            continue;
          if (
            Object.values(state.actions).some(
              (action) =>
                action.receipt.kind === "SUPERSEDE_SUPPLIER_JOB" &&
                action.receipt.status === "SUCCEEDED" &&
                action.effect.attributes.molecule_superseded_by !==
                  plan.planId &&
                action.resource?.id === previous.resource?.id &&
                action.resource?.domain === previous.resource?.domain,
            )
          )
            continue;
          const replacement = plan.nodes.find(
            (item) => item.nodeId === node.nodeId,
          );
          const edges = (source: ProductionPlan) =>
            source.edges.filter(
              (edge) =>
                edge.fromNodeId === node.nodeId ||
                edge.toNodeId === node.nodeId,
            );
          if (
            replacement &&
            digest([node, edges(old.plan)]) ===
              digest([replacement, edges(plan)]) &&
            previous.effect.attributes.molecule_instructions ===
              instructions.get(node.nodeId)
          ) {
            reusable[digest(node.nodeId)] = previous.resource;
          } else {
            const action = await this.supersedeJob(
              state,
              journal,
              previous,
              plan.planId,
              traceId,
            );
            const index = receipt.actions.findIndex(
              (item) => item.actionKey === action.receipt.actionKey,
            );
            if (index >= 0) receipt.actions[index] = action.receipt;
            else receipt.actions.push(action.receipt);
            if (action.receipt.status !== "SUCCEEDED") return finish();
          }
        }
        old.superseded = true;
        await journal.save(
          state,
          eventFor(
            traceId,
            "shopify.plan.superseded",
            { previousPlanId: old.plan.planId },
            plan.orderId,
            plan.planId,
          ),
        );
      }
      const latestProduct = this.latestResource(state, "COMPOSITE_PRODUCT");
      const product = await this.execute(
        state,
        journal,
        {
          operation: "product",
          domain: this.effects.centralDomain,
          actionKey: actionKey("composite-product", plan.orderId, plan.planId),
          traceId,
          orderId: plan.orderId,
          planId: plan.planId,
          title: `Molecule complete order ${plan.orderId}`,
          handle: `molecule-${digest(plan.orderId).slice(0, 32)}`,
          amount: plan.totalCost,
          currency: plan.currency,
          attributes: {},
          ...(latestProduct ? { existing: latestProduct } : {}),
        },
        "COMPOSITE_PRODUCT",
      );
      receipt.actions.push(product.receipt);
      if (!product.resource || product.receipt.status !== "SUCCEEDED")
        return finish();
      receipt.compositeProduct = {
        storeDomain: product.resource.domain,
        productGid: product.resource.id,
        ...(product.resource.variantId
          ? { variantGid: product.resource.variantId }
          : {}),
        ...(product.resource.adminUrl
          ? { adminUrl: product.resource.adminUrl }
          : {}),
      };
      for (const node of plan.nodes) {
        const effect: ShopifyEffect = {
          operation: "draft",
          domain: this.effects.supplierDomain(node.merchantId),
          actionKey: this.jobKey(plan, node.nodeId),
          traceId,
          orderId: plan.orderId,
          planId: plan.planId,
          nodeId: node.nodeId,
          merchantId: node.merchantId,
          title: `${node.quantity} × ${node.selectedItem?.sku ?? node.capabilityId}`,
          ...(node.selectedItem ? { quantity: node.quantity, unitAmount: node.unitCost, sku: node.selectedItem.sku,
            ...(node.selectedItem.itemKind === "physical" && node.selectedItem.variantGid ? { variantId: node.selectedItem.variantGid } : {}) } : {}),
          amount: node.totalCost,
          currency: plan.currency,
          attributes: {
            molecule_instructions: instructions.get(node.nodeId)!,
            molecule_node_id: node.nodeId,
            molecule_merchant_id: node.merchantId,
            molecule_capability_id: node.capabilityId,
            molecule_quantity: String(node.quantity),
            ...(node.selectedItem ? {
              molecule_sku: node.selectedItem.sku,
              molecule_binding_id: node.selectedItem.bindingId,
              molecule_catalog_version: node.catalogVersion ?? "",
              molecule_variant_id: node.selectedItem.variantId,
              molecule_assets: JSON.stringify(node.customizationAssets ?? []),
              molecule_synthetic: String(node.synthetic ?? false),
            } : {}),
            molecule_upstream_nodes: plan.edges
              .filter((edge) => edge.toNodeId === node.nodeId)
              .map((edge) => edge.fromNodeId)
              .join(","),
            molecule_downstream_nodes: plan.edges
              .filter((edge) => edge.fromNodeId === node.nodeId)
              .map((edge) => edge.toNodeId)
              .join(","),
            ...(node.completesAt
              ? { molecule_deadline: node.completesAt }
              : {}),
          },
          ...(reusable[digest(node.nodeId)]
            ? { existing: reusable[digest(node.nodeId)]! }
            : {}),
        };
        const job = await this.execute(state, journal, effect, "SUPPLIER_JOB");
        receipt.actions.push(job.receipt);
        if (job.resource && job.receipt.status === "SUCCEEDED") {
          receipt.supplierJobs.push({
            merchantId: node.merchantId,
            nodeId: node.nodeId,
            draftOrderGid: job.resource.id,
            storeDomain: job.resource.domain,
          });
        }
      }
      if (receipt.supplierJobs.length !== plan.nodes.length) return finish();
      const customer = this.latestResource(state, "CUSTOMER_ORDER");
      const customerAction = await this.execute(
        state,
        journal,
        {
          operation: "draft",
          domain: this.effects.centralDomain,
          actionKey: actionKey("customer-order", plan.orderId, plan.planId),
          traceId,
          orderId: plan.orderId,
          planId: plan.planId,
          title: `Molecule complete order ${plan.orderId}`,
          amount: plan.totalCost,
          currency: plan.currency,
          attributes: {
            molecule_product_id: product.resource.id,
            molecule_price_basis: "complete_order",
          },
          ...(product.resource.variantId
            ? { variantId: product.resource.variantId }
            : {}),
          ...(customer ? { existing: customer } : {}),
        },
        "CUSTOMER_ORDER",
      );
      receipt.actions.push(customerAction.receipt);
      if (
        customerAction.resource &&
        customerAction.receipt.status === "SUCCEEDED"
      ) {
        receipt.customerOrder = {
          draftOrderGid: customerAction.resource.id,
          ...(customerAction.resource.checkoutUrl
            ? { checkoutUrl: customerAction.resource.checkoutUrl }
            : {}),
        };
      }
      return finish();
    });
  }

  reconcile(plan: ProductionPlan, traceId: string): Promise<ExecutionReceipt> {
    return this.commit(plan, traceId);
  }

  async supersede(
    orderId: string,
    planId: string,
    traceId: string,
  ): Promise<ExecutionReceipt> {
    if (!traceId.trim()) throw new ShopifyError("INVALID_TRACE");
    if (this.effects instanceof RealShopifyEffects)
      this.effects.assertEnabled();
    return this.repository.withOrder(orderId, async (journal) => {
      const state = await journal.load();
      if (!state) throw new ShopifyError("ORDER_NOT_FOUND");
      this.checkState(state);
      const old = state.plans[digest(planId)];
      if (!old) throw new ShopifyError("PLAN_NOT_FOUND");
      if (state.targetPlanId !== planId)
        throw new ShopifyError("PLAN_SUPERSEDED");
      if (
        Object.values(state.actions).some(
          (action) =>
            action.receipt.status === "PENDING" &&
            !this.isCancellation(action, planId),
        ) ||
        Object.values(state.plans).some(
          (previous) => previous.plan.planId !== planId && !previous.superseded,
        )
      ) {
        throw new ShopifyError("PREVIOUS_EXECUTION_PENDING");
      }
      const receipt: ExecutionReceipt = {
        orderId,
        planId,
        intentVersion: old.plan.intentVersion,
        actions: [],
        supplierJobs: [],
      };
      for (const node of old.plan.nodes) {
        const previous = this.previousJob(state, old, node.nodeId);
        if (previous?.receipt.status === "PENDING")
          throw new ShopifyError("PREVIOUS_EXECUTION_PENDING");
        if (!previous?.resource) continue;
        const action = await this.supersedeJob(
          state,
          journal,
          previous,
          `cancel:${planId}`,
          traceId,
        );
        receipt.actions.push(action.receipt);
      }
      if (receipt.actions.every((action) => action.status === "SUCCEEDED"))
        old.superseded = true;
      await journal.save(
        state,
        eventFor(
          traceId,
          "shopify.supersede.recorded",
          { actions: receipt.actions },
          orderId,
          planId,
        ),
      );
      return ExecutionReceiptSchema.parse(receipt);
    });
  }

  private checkState(state: ShopifyOrderState): void {
    if (
      state.mode !== this.effects.mode ||
      state.binding !== this.effects.binding
    )
      throw new ShopifyError("REPOSITORY_BINDING_MISMATCH");
  }

  private jobKey(plan: ProductionPlan, nodeId: string): string {
    return actionKey("supplier-job", plan.orderId, plan.planId, nodeId);
  }

  private isCancellation(action: ActionRecord, planId: string): boolean {
    return (
      action.receipt.kind === "SUPERSEDE_SUPPLIER_JOB" &&
      action.effect.attributes.molecule_superseded_by === `cancel:${planId}`
    );
  }

  private hasCancellation(state: ShopifyOrderState, planId: string): boolean {
    return Object.values(state.actions).some((action) =>
      this.isCancellation(action, planId),
    );
  }

  private previousJob(
    state: ShopifyOrderState,
    old: ShopifyOrderState["plans"][string],
    nodeId: string,
  ): ActionRecord | undefined {
    const previous = state.actions[this.jobKey(old.plan, nodeId)];
    if (previous?.resource) return previous;
    const inherited = old.reusedJobs[digest(nodeId)];
    if (!inherited) return previous;
    return Object.values(state.actions).find(
      (action) =>
        action.receipt.kind === "SUPPLIER_JOB" &&
        action.receipt.status === "SUCCEEDED" &&
        action.resource?.id === inherited.id &&
        action.resource.domain === inherited.domain,
    );
  }

  private latestResource(
    state: ShopifyOrderState,
    kind: ExecutionActionReceipt["kind"],
  ): ShopifyResource | undefined {
    return Object.values(state.actions)
      .filter(
        (action) =>
          action.receipt.kind === kind && action.receipt.status === "SUCCEEDED",
      )
      .at(-1)?.resource;
  }

  private async supersedeJob(
    state: ShopifyOrderState,
    journal: OrderJournal,
    previous: ActionRecord,
    replacementPlanId: string,
    traceId: string,
  ): Promise<ActionRecord> {
    return this.execute(
      state,
      journal,
      {
        ...previous.effect,
        operation: "supersede",
        existing: previous.resource!,
        actionKey: actionKey(
          "supersede-job",
          previous.receipt.actionKey,
          replacementPlanId,
        ),
        traceId,
        attributes: {
          ...previous.effect.attributes,
          molecule_superseded_by: replacementPlanId,
        },
      },
      "SUPERSEDE_SUPPLIER_JOB",
    );
  }

  private async execute(
    state: ShopifyOrderState,
    journal: OrderJournal,
    proposed: ShopifyEffect,
    kind: ExecutionActionReceipt["kind"],
  ): Promise<ActionRecord> {
    let record = state.actions[proposed.actionKey];
    if (record?.receipt.status === "SUCCEEDED") return record;
    const pending = record?.receipt.status === "PENDING";
    if (!record) {
      record = {
        effect: proposed,
        receipt: { actionKey: proposed.actionKey, kind, status: "PENDING" },
      };
      state.actions[proposed.actionKey] = record;
    } else {
      record.receipt = {
        actionKey: proposed.actionKey,
        kind,
        status: "PENDING",
      };
    }
    await journal.save(
      state,
      eventFor(
        proposed.traceId,
        "shopify.action.pending",
        { ...record.receipt, mode: state.mode },
        proposed.orderId,
        proposed.planId,
      ),
    );
    try {
      const resource = pending
        ? await this.effects.recover(record.effect, state)
        : await this.effects.perform(record.effect, state);
      if (resource) {
        record.resource = resource;
        record.receipt = {
          actionKey: proposed.actionKey,
          kind,
          status: "SUCCEEDED",
          providerRef: resource.id,
        };
      } else {
        record.receipt.errorCode = "OUTCOME_UNKNOWN";
      }
    } catch (error) {
      const failure =
        error instanceof ShopifyError
          ? error
          : new ShopifyError("PROVIDER_ERROR", true);
      if (failure.resource) record.resource = failure.resource;
      record.receipt = {
        actionKey: proposed.actionKey,
        kind,
        status: pending || failure.uncertain ? "PENDING" : "FAILED",
        errorCode: failure.code,
        ...(record.resource ? { providerRef: record.resource.id } : {}),
      };
    }
    await journal.save(
      state,
      eventFor(
        proposed.traceId,
        `shopify.action.${record.receipt.status.toLowerCase()}`,
        { ...record.receipt, mode: state.mode },
        proposed.orderId,
        proposed.planId,
      ),
    );
    return record;
  }
}

export class MockShopifyClient extends DurableShopifyClient {
  constructor(options: ShopifyClientOptions & MockShopifyOptions) {
    super(
      options.repository,
      new MockShopifyEffects(options),
      options.jobInstructions,
    );
  }
}

export class RealShopifyClient extends DurableShopifyClient {
  constructor(options: ShopifyClientOptions & RealShopifyEffectsOptions) {
    super(
      options.repository,
      new RealShopifyEffects(options),
      options.jobInstructions,
    );
  }
}

export function createShopifyClient(
  options:
    | ({ mode: "mock" } & ShopifyClientOptions & MockShopifyOptions)
    | ({ mode: "real" } & ShopifyClientOptions & RealShopifyEffectsOptions),
): ShopifyClient {
  return options.mode === "mock"
    ? new MockShopifyClient(options)
    : new RealShopifyClient(options);
}
