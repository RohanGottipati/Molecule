import {
  CompileIntentRequestSchema,
  ProductIntentSchema,
  ProductionPlanSchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
  SolverInputSchema,
  type CompileIntentRequest,
  type MoleculeEvent,
  type OrderSessionState,
} from "@molecule/contracts";

import type {
  MerchantAgentClient,
  OpenAIClient,
  RealityClient,
  ShopifyClient,
  SolverClient,
} from "../clients.js";
import { makeEvent, type EventStore } from "../events/EventStore.js";
import type { SessionRepository } from "../repositories.js";
import type { OrderSession } from "../session/OrderSession.js";
import { isStale } from "../session/staleGuard.js";
import { canAcceptCorrection, transition } from "../session/transitions.js";

export interface OrchestratorDependencies {
  sessions: SessionRepository;
  events: EventStore;
  openai: OpenAIClient;
  reality: RealityClient;
  merchantAgents: MerchantAgentClient;
  solver: SolverClient;
  shopify: ShopifyClient;
  quoteTimeoutMs?: number;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}

  private async load(orderId: string): Promise<OrderSession> {
    const session = await this.deps.sessions.get(orderId);
    if (!session) throw new Error(`Order ${orderId} not found`);
    return session;
  }

  private async emit(
    session: OrderSession,
    eventType: string,
    source: MoleculeEvent["source"],
    payload: Record<string, unknown> = {},
    merchantId?: string,
  ): Promise<void> {
    await this.deps.events.append(
      makeEvent({
        traceId: session.traceId,
        orderId: session.orderId,
        planId: session.activePlan?.planId,
        merchantId,
        eventType,
        source,
        payload,
      }),
    );
  }

  private async move(
    session: OrderSession,
    state: OrderSessionState,
    eventType: string,
    source: MoleculeEvent["source"] = "orchestrator",
    payload: Record<string, unknown> = {},
    solverPlan = session.activePlan ?? undefined,
  ): Promise<OrderSession> {
    const next = transition(session, state, { solverPlan });
    const persisted = await this.deps.events.append(
      makeEvent({
        traceId: next.traceId,
        orderId: next.orderId,
        planId: next.activePlan?.planId,
        eventType,
        source,
        payload: { state, ...payload },
      }),
    );
    next.eventCursor = persisted.cursor;
    await this.deps.sessions.save(next, session.revision);
    return next;
  }

  async submitMessage(request: CompileIntentRequest): Promise<OrderSession> {
    const input = CompileIntentRequestSchema.parse(request);
    let session = await this.load(input.orderId);
    if (!canAcceptCorrection(session.state)) {
      throw new Error(
        `Order cannot accept a correction while ${session.state}`,
      );
    }
    if (session.activePlan) {
      session.planGeneration += 1;
      await this.emit(session, "plan.invalidated", "orchestrator", {
        reason: "customer_correction",
        previousPlanId: session.activePlan.planId,
      });
      session.activePlan = null;
    }
    session = await this.move(
      session,
      "COMPILING_INTENT",
      session.intent ? "intent.updated" : "intent.received",
      "ui",
    );
    const result = await this.deps.openai.compileIntent({
      ...input,
      previousIntent: session.intent ?? input.previousIntent,
    });
    if (result.status === "UNSUPPORTED") {
      session.lastErrorCode = "UNSUPPORTED";
      return this.move(session, "FAILED", "intent.unsupported", "openai", {
        reason: result.reason,
      });
    }
    if (result.status === "NEEDS_CLARIFICATION") {
      session.intent = result.draft;
      session.intentVersion = result.draft.version;
      return this.move(
        session,
        "NEEDS_CLARIFICATION",
        "intent.clarification.required",
        "openai",
        { questions: result.questions, intentVersion: result.draft.version },
      );
    }

    session.intent = {
      ...result.intent,
      budgetMax: result.intent.budgetMax ?? null,
    };
    session.intentVersion = result.intent.version;
    session.planGeneration += 1;
    session = await this.move(
      session,
      "INTENT_COMPILED",
      "intent.compiled",
      "openai",
      {
        intentVersion: result.intent.version,
      },
    );
    return this.plan(session);
  }

  async plan(
    current: OrderSession,
    excludedMerchantIds: string[] = [],
  ): Promise<OrderSession> {
    const intent = ProductIntentSchema.parse({
      ...current.intent,
      budgetMax: current.intent?.budgetMax ?? undefined,
    });
    let session = await this.move(
      current,
      "DISCOVERING",
      "candidate.search.started",
    );
    session.candidates = await this.deps.reality.searchCandidates(
      intent,
      excludedMerchantIds,
    );
    session = await this.move(
      session,
      "CANDIDATES_READY",
      "candidate.search.completed",
      "orchestrator",
      { count: session.candidates.length },
    );
    session = await this.move(
      session,
      "QUOTING",
      "merchant.quote.fanout.started",
    );

    const quotePromises = session.candidates.map(async (candidate) => {
      await this.emit(
        session,
        "merchant.quote.requested",
        "orchestrator",
        { capabilityId: candidate.capabilityId },
        candidate.merchantId,
      );
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.deps.quoteTimeoutMs ?? 8_000,
      );
      try {
        const request = QuoteRequestSchema.parse({
          orderId: session.orderId,
          traceId: session.traceId,
          merchantId: candidate.merchantId,
          capabilityId: candidate.capabilityId,
          intentVersion: intent.version,
          quantity: intent.quantity,
          deadline: intent.deadline,
          currency: intent.currency,
          hardConstraints: intent.hardConstraints,
          softPreferences: intent.softPreferences,
          hold: false,
        });
        const quote = QuoteResponseSchema.parse(
          await this.deps.merchantAgents.quote(request, controller.signal),
        );
        await this.emit(
          session,
          "merchant.quote.received",
          "backboard",
          { capabilityId: candidate.capabilityId, status: quote.status },
          candidate.merchantId,
        );
        return quote;
      } catch (error) {
        await this.emit(
          session,
          "merchant.quote.timeout",
          "backboard",
          {
            capabilityId: candidate.capabilityId,
            error: error instanceof Error ? error.name : "unknown",
          },
          candidate.merchantId,
        );
        return null;
      } finally {
        clearTimeout(timer);
      }
    });
    session.quotes = (await Promise.all(quotePromises)).filter(
      (quote): quote is NonNullable<typeof quote> => quote !== null,
    );
    session = await this.move(
      session,
      "QUOTED",
      "merchant.quote.fanout.completed",
      "orchestrator",
      {
        count: session.quotes.length,
      },
    );
    session = await this.move(session, "SOLVING", "solver.started", "solver");
    const generation = session.planGeneration;
    const plan = ProductionPlanSchema.parse(
      await this.deps.solver.solve(
        SolverInputSchema.parse({
          orderId: session.orderId,
          traceId: session.traceId,
          generation,
          now: new Date().toISOString(),
          intent,
          candidates: session.candidates,
          quotes: session.quotes,
          changePenaltyNodeIds:
            session.activePlan?.nodes.map(({ nodeId }) => nodeId) ?? [],
        }),
      ),
    );
    const latest = await this.load(session.orderId);
    if (
      isStale(latest, {
        intentVersion: intent.version,
        planGeneration: generation,
      })
    ) {
      await this.emit(
        session,
        "workflow.stale_result.ignored",
        "orchestrator",
        {
          resultIntentVersion: intent.version,
          resultGeneration: generation,
        },
      );
      return latest;
    }
    session.activePlan = plan;
    if (plan.status === "UNSAT") {
      session = await this.move(
        session,
        "PLAN_UNSAT",
        "solver.unsat",
        "solver",
        {
          relaxations: plan.unsatRelaxations,
        },
        plan,
      );
      return this.move(
        session,
        "NEEDS_HUMAN",
        "order.needs_human",
        "orchestrator",
      );
    }
    session = await this.move(
      session,
      "PLAN_VALIDATED",
      "solver.valid",
      "solver",
      {},
      plan,
    );
    return this.move(
      session,
      "AWAITING_APPROVAL",
      "execution.approval.requested",
      "orchestrator",
    );
  }

  async approve(
    orderId: string,
    planId: string,
    intentVersion: number,
  ): Promise<OrderSession> {
    let session = await this.load(orderId);
    if (
      session.activePlan?.planId !== planId ||
      session.intentVersion !== intentVersion ||
      session.activePlan.status !== "VALID"
    ) {
      throw new Error(
        "Approval is stale or does not match the active solver plan",
      );
    }
    const approvedPlan = session.activePlan;
    session = await this.move(session, "EXECUTING", "execution.started");
    const receipt = await this.deps.shopify.commit(
      approvedPlan,
      session.traceId,
    );
    session.executionReceipt = receipt;
    session = await this.move(
      session,
      "SKU_CREATED",
      "shopify.product.created",
      "shopify",
      {
        productGid: receipt.compositeProduct?.productGid,
      },
    );
    session = await this.move(
      session,
      "SUPPLIER_JOBS_CREATED",
      "shopify.supplier_job.created",
      "shopify",
      { count: receipt.supplierJobs.length },
    );
    session = await this.move(
      session,
      "CUSTOMER_ORDER_CREATED",
      "shopify.customer_order.created",
      "shopify",
      { draftOrderGid: receipt.customerOrder?.draftOrderGid },
    );
    return this.move(session, "COMPLETED", "order.completed");
  }

  async recoverSupplier(
    orderId: string,
    merchantId: string,
  ): Promise<OrderSession> {
    let session = await this.load(orderId);
    const previousPlan = session.activePlan;
    session = await this.move(
      session,
      "AT_RISK",
      "plan.invalidated",
      "orchestrator",
      {
        reason: "supplier_offline",
        merchantId,
      },
    );
    session.planGeneration += 1;
    session = await this.move(session, "RECOVERING", "recovery.started");
    session = await this.move(
      session,
      "INTENT_COMPILED",
      "recovery.replanning",
      "orchestrator",
    );
    const recovered = await this.plan(session, [merchantId]);
    const deadline = session.intent?.deadline
      ? new Date(session.intent.deadline).getTime()
      : Number.POSITIVE_INFINITY;
    const completion = recovered.activePlan?.estimatedCompletion
      ? new Date(recovered.activePlan.estimatedCompletion).getTime()
      : Number.POSITIVE_INFINITY;
    if (
      recovered.activePlan?.status !== "VALID" ||
      (previousPlan &&
        (recovered.activePlan.totalCost > previousPlan.totalCost ||
          completion > deadline))
    ) {
      return recovered.state === "NEEDS_HUMAN"
        ? recovered
        : this.move(recovered, "NEEDS_HUMAN", "recovery.failed");
    }
    await this.emit(recovered, "recovery.completed", "orchestrator", {
      previousPlanId: previousPlan?.planId,
      replacementPlanId: recovered.activePlan.planId,
    });
    return this.approve(
      recovered.orderId,
      recovered.activePlan.planId,
      recovered.intentVersion,
    );
  }
}
