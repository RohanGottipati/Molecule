import { randomUUID } from "node:crypto";
import {
  CompileIntentRequestSchema,
  ProductIntentSchema,
  ProductionPlanSchema,
  CurrentQuoteRequestSchema,
  QuoteResponseSchema,
  SolverInputSchema,
  type CompileIntentRequest,
  type MoleculeEvent,
  type OrderSessionState,
  type DesktopCommand,
  type ExecutionReceipt,
  type ProductionMessage,
  deriveProjectCapabilities,
  ProductionMessageSchema,
  hasUncompiledContext,
} from "@molecule/contracts";

import type {
  MerchantAgentClient,
  OpenAIClient,
  RealityClient,
  ShopifyClient,
  SolverClient,
} from "../clients.js";
import { makeEvent, type EventStore } from "../events/EventStore.js";
import {
  SessionConflictError,
  SupersededSubmissionError,
  type SessionRepository,
} from "../repositories.js";
import { Serial } from "../serial.js";
import type { OrderSession } from "../session/OrderSession.js";
import { isStale } from "../session/staleGuard.js";
import { canAcceptCorrection, transition } from "../session/transitions.js";
import { RequestProblem, apiFailure } from "../errors.js";
import { ExecutionInterruptedError } from "../clients/ExecutionInterruptedError.js";
import type { ContextStore } from "../LocalStore.js";

export interface SubmissionIdentity {
  messageId?: string;
  source?: ProductionMessage["source"];
  expectedRevision?: number;
  originalText?: string;
}

export interface OrchestratorDependencies {
  sessions: SessionRepository;
  events: EventStore;
  contexts: Pick<ContextStore, "contexts">;
  openai: OpenAIClient;
  reality: RealityClient;
  merchantAgents: MerchantAgentClient;
  solver: SolverClient;
  shopify: ShopifyClient;
  quoteTimeoutMs?: number;
}

export class Orchestrator {
  private readonly transitions = new Serial();
  private readonly compiling = new Map<string, Promise<OrderSession>>();
  constructor(private readonly deps: OrchestratorDependencies) {}

  private async load(orderId: string): Promise<OrderSession> {
    const session = await this.deps.sessions.get(orderId);
    if (!session)
      throw new RequestProblem(
        404,
        "NOT_FOUND",
        "Project not found. Check the link or start a new project.",
      );
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
    return this.transitions.run(async () => {
      const latest = await this.load(session.orderId);
      if (latest.revision !== session.revision)
        throw new SessionConflictError("Workflow superseded");
      if (
        state === "EXECUTING" &&
        hasUncompiledContext(
          latest,
          await this.attachedContexts(session.orderId),
        )
      )
        throw new RequestProblem(
          409,
          "CONFLICT",
          "Submit a brief update to compile the attached context before approval.",
        );
      const next = transition(session, state, { solverPlan });
      const event = makeEvent({
        traceId: next.traceId,
        orderId: next.orderId,
        planId: next.activePlan?.planId,
        eventType,
        source,
        payload: { state, ...payload },
      });
      if (this.deps.sessions.saveWithEvent)
        return this.deps.sessions.saveWithEvent(next, session.revision, event);
      const persisted = await this.deps.events.append(event);
      next.eventCursor = persisted.cursor;
      await this.deps.sessions.save(next, session.revision);
      return next;
    });
  }

  async submitMessage(
    request: CompileIntentRequest,
    identity: SubmissionIdentity = {},
  ): Promise<OrderSession> {
    const operation = this.compileMessage(request, identity);
    this.compiling.set(request.orderId, operation);
    try {
      return await operation;
    } finally {
      if (this.compiling.get(request.orderId) === operation)
        this.compiling.delete(request.orderId);
    }
  }

  private async allowSuperseded(
    orderId: string,
    operation: () => Promise<OrderSession>,
  ) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SessionConflictError) {
        const latest = await this.load(orderId);
        if (latest.state === "CANCELLED") return latest;
        throw new SupersededSubmissionError("Submission superseded");
      }
      throw error;
    }
  }

  async capabilities(orderId: string) {
    const session = await this.load(orderId);
    const executionStarted = (await this.deps.events.list(orderId, 0)).some(
      ({ event }) => event.eventType === "execution.started",
    );
    return {
      orderId,
      revision: session.revision,
      capabilities: deriveProjectCapabilities(
        session,
        executionStarted,
        await this.attachedContexts(orderId),
      ),
    };
  }

  private async attachedContexts(orderId: string) {
    return (await this.deps.contexts.contexts(orderId))
      .filter((context) => context.attached)
      .map((context) => context.asset);
  }

  private async failCurrent(
    session: OrderSession,
    error: unknown,
    eventType = "workflow.failed",
  ) {
    const latest = await this.load(session.orderId);
    if (latest.state === "CANCELLED") return latest;
    if (
      error instanceof SessionConflictError ||
      latest.planGeneration !== session.planGeneration
    )
      throw new SupersededSubmissionError("Submission superseded");
    if (!canAcceptCorrection(latest.state) && latest.state !== "RECOVERING")
      throw error;
    const normalized =
      error instanceof Error ? error : new Error("Provider failed");
    latest.lastErrorCode = normalized.name;
    try {
      await this.move(latest, "FAILED", eventType, "orchestrator", {
        code: latest.lastErrorCode,
        reason: apiFailure(normalized, latest.traceId).body.message,
        executionMayHaveEffects:
          (await this.capabilities(latest.orderId)).capabilities
            .requiresOperator || latest.executionReceipt !== null,
      });
    } catch (failure) {
      if (failure instanceof SessionConflictError)
        throw new SupersededSubmissionError("Submission superseded");
      throw failure;
    }
    throw error;
  }

  private async beginCorrection(
    orderId: string,
    update?: (session: OrderSession) => void,
    message?: Omit<
      ProductionMessage,
      "acceptedAt" | "acceptedRevision" | "planGeneration"
    >,
    expectedRevision?: number,
  ) {
    return this.transitions.run(async () => {
      const session = await this.load(orderId);
      if (
        expectedRevision !== undefined &&
        session.revision !== expectedRevision
      )
        throw new RequestProblem(
          409,
          "STALE_VERSION",
          "The project changed before this submission was accepted. Review the current brief.",
        );
      const executionStarted = (await this.deps.events.list(orderId, 0)).some(
        ({ event }) => event.eventType === "execution.started",
      );
      if (
        !deriveProjectCapabilities(session, executionStarted).canSubmitMessage
      )
        throw new RequestProblem(
          409,
          "INVALID_TRANSITION",
          executionStarted || session.executionReceipt
            ? "Execution may have provider effects. Ask the operator to reconcile the retained receipts before changing this project."
            : `Order cannot accept a correction while ${session.state}`,
        );
      const revision = session.revision;
      const previousPlanId = session.activePlan?.planId;
      update?.(session);
      session.planGeneration += 1;
      session.activePlan = null;
      session.candidates = [];
      session.quotes = [];
      session.lastErrorCode = null;
      session.state = "COMPILING_INTENT";
      session.revision += 1;
      session.updatedAt = new Date().toISOString();
      const event = makeEvent({
        traceId: session.traceId,
        orderId: session.orderId,
        eventType: previousPlanId ? "plan.invalidated" : "intent.received",
        source: "ui",
        payload: {
          reason: "customer_correction",
          previousPlanId,
          state: session.state,
          ...(message
            ? {
                productionMessage: ProductionMessageSchema.parse({
                  ...message,
                  acceptedAt: session.updatedAt,
                  acceptedRevision: session.revision,
                  planGeneration: session.planGeneration,
                }),
              }
            : {}),
        },
      });
      if (this.deps.sessions.saveWithEvent)
        return this.deps.sessions.saveWithEvent(session, revision, event);
      await this.deps.sessions.save(session, revision);
      await this.deps.events.append(event);
      return session;
    });
  }

  async revise(
    orderId: string,
    command: Extract<
      DesktopCommand,
      { name: "add_constraint" | "remove_constraint" | "request_recompile" }
    >,
    actionId: string,
    originalText?: string,
    expectedRevision?: number,
  ): Promise<OrderSession> {
    return this.allowSuperseded(orderId, async () => {
      if (!(await this.load(orderId)).intent) await this.compiling.get(orderId);
      const message = originalText
        ? {
            messageId: actionId,
            orderId,
            source: "desktop" as const,
            text: originalText,
            assets: [] as ProductionMessage["assets"],
          }
        : undefined;
      let session = await this.beginCorrection(
        orderId,
        (current) => {
          if (!current.intent)
            throw new Error(
              "Describe the project before changing its constraints",
            );
          const intent = current.intent;
          if (message) message.assets = intent.assets;
          if (command.name === "add_constraint") {
            const { hard, ...constraint } = command.args.constraint;
            if (hard)
              intent.hardConstraints.push({
                ...constraint,
                constraintId: actionId,
              });
            else
              intent.softPreferences.push({
                ...constraint,
                constraintId: actionId,
                weight: 1,
              });
          } else if (command.name === "remove_constraint") {
            const id = command.args.constraintId;
            if (
              ![...intent.hardConstraints, ...intent.softPreferences].some(
                (item) => item.constraintId === id,
              )
            )
              throw new Error("Constraint not found");
            intent.hardConstraints = intent.hardConstraints.filter(
              (item) => item.constraintId !== id,
            );
            intent.softPreferences = intent.softPreferences.filter(
              (item) => item.constraintId !== id,
            );
          }
          intent.version += 1;
          current.intentVersion = intent.version;
        },
        message,
        expectedRevision,
      );
      const accepted = session;
      try {
        await this.emit(
          session,
          command.name === "add_constraint"
            ? "constraint.added"
            : command.name === "remove_constraint"
              ? "constraint.removed"
              : "plan.recompile.requested",
          "ui",
          {
            actionId,
            intentVersion: session.intentVersion,
          },
        );
        const complete = ProductIntentSchema.safeParse({
          ...session.intent,
          budgetMax: session.intent?.budgetMax ?? undefined,
        });
        if (!complete.success || complete.data.ambiguityFlags.length > 0) {
          const clarified = await this.move(
            session,
            "NEEDS_CLARIFICATION",
            "intent.clarification.required",
            "orchestrator",
            {
              questions:
                session.intent?.ambiguityFlags.map(
                  ({ question, reason }) => question ?? reason,
                ) ?? [],
              intentVersion: session.intentVersion,
            },
          );
          if (originalText)
            await this.messageOutcome(accepted, actionId, clarified);
          return clarified;
        }
        session = await this.move(
          session,
          "INTENT_COMPILED",
          "intent.compiled",
        );
        const result = await this.plan(session);
        if (originalText) await this.messageOutcome(accepted, actionId, result);
        return result;
      } catch (error) {
        try {
          const cancelled = await this.failCurrent(session, error);
          if (originalText)
            await this.messageOutcome(accepted, actionId, cancelled);
          return cancelled;
        } catch (failure) {
          if (originalText)
            await this.messageOutcome(accepted, actionId, undefined, failure);
          throw failure;
        }
      }
    });
  }

  async cancel(orderId: string): Promise<OrderSession> {
    const session = await this.load(orderId);
    const { capabilities } = await this.capabilities(orderId);
    if (!capabilities.canCancelPlanning)
      throw new RequestProblem(
        409,
        "INVALID_TRANSITION",
        capabilities.reason ??
          "This project cannot cancel planning in its current state.",
      );
    session.planGeneration += 1;
    session.activePlan = null;
    return this.move(session, "CANCELLED", "project.cancelled", "ui");
  }

  private async compileMessage(
    request: CompileIntentRequest,
    identity: SubmissionIdentity,
  ): Promise<OrderSession> {
    const input = CompileIntentRequestSchema.parse(request);
    const messageId = identity.messageId ?? randomUUID();
    let session = await this.beginCorrection(
      input.orderId,
      undefined,
      {
        messageId,
        orderId: input.orderId,
        source: identity.source ?? "unknown",
        text: identity.originalText ?? input.text,
        assets: input.assets,
        correction: input.correction,
      },
      identity.expectedRevision,
    );
    const accepted = session;
    try {
      const result = await this.deps.openai.compileIntent({
        ...input,
        previousIntent: session.intent ?? input.previousIntent,
      });
      if (result.status === "UNSUPPORTED") {
        session.lastErrorCode = "UNSUPPORTED";
        const failed = await this.move(
          session,
          "FAILED",
          "intent.unsupported",
          "openai",
          {
            reason: result.reason,
          },
        );
        await this.messageOutcome(accepted, messageId, failed);
        return failed;
      }
      if (result.status === "NEEDS_CLARIFICATION") {
        session.intent = result.draft;
        session.intentVersion = result.draft.version;
        const clarified = await this.move(
          session,
          "NEEDS_CLARIFICATION",
          "intent.clarification.required",
          "openai",
          { questions: result.questions, intentVersion: result.draft.version },
        );
        await this.messageOutcome(accepted, messageId, clarified);
        return clarified;
      }

      session.intent = {
        ...result.intent,
        budgetMax: result.intent.budgetMax ?? null,
      };
      session.intentVersion = result.intent.version;
      session = await this.move(
        session,
        "INTENT_COMPILED",
        "intent.compiled",
        "openai",
        {
          intentVersion: result.intent.version,
        },
      );
      const planned = await this.plan(session);
      await this.messageOutcome(accepted, messageId, planned);
      return planned;
    } catch (error) {
      try {
        const cancelled = await this.failCurrent(session, error);
        await this.messageOutcome(accepted, messageId, cancelled);
        return cancelled;
      } catch (failure) {
        await this.messageOutcome(accepted, messageId, undefined, failure);
        throw failure;
      }
    }
  }

  private async messageOutcome(
    session: OrderSession,
    messageId: string,
    result?: OrderSession,
    error?: unknown,
  ) {
    const superseded = error instanceof SessionConflictError;
    await this.emit(session, "message.outcome", "orchestrator", {
      messageId,
      status: superseded
        ? "superseded"
        : error || result?.state === "FAILED"
          ? "failed"
          : result?.state === "CANCELLED"
            ? "cancelled"
            : "succeeded",
      resultRevision: result?.revision ?? null,
      reason: error
        ? apiFailure(
            error instanceof Error ? error : new Error(),
            session.traceId,
          ).body.message
        : result?.state === "FAILED"
          ? "The production request could not be applied. Review the project events."
          : null,
    });
  }

  async plan(
    current: OrderSession,
    excludedMerchantIds: string[] = [],
  ): Promise<OrderSession> {
    return this.allowSuperseded(current.orderId, () =>
      this.planCurrent(current, excludedMerchantIds),
    );
  }

  private async planCurrent(
    current: OrderSession,
    excludedMerchantIds: string[],
  ) {
    const intent = ProductIntentSchema.parse({
      ...current.intent,
      budgetMax: current.intent?.budgetMax ?? undefined,
    });
    let session = await this.move(
      current,
      "DISCOVERING",
      "candidate.search.started",
    );
    const offline = new Set(excludedMerchantIds);
    for (const { event } of await this.deps.events.list(session.orderId, 0)) {
      if (event.eventType === "supplier.offline" && event.merchantId)
        offline.add(event.merchantId);
    }
    session.candidates = await this.deps.reality.searchCandidates(intent, [
      ...offline,
    ]);
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new DOMException(
              "Merchant quote deadline exceeded",
              "TimeoutError",
            ),
          );
        }, this.deps.quoteTimeoutMs ?? 8_000);
      });
      try {
        const request = CurrentQuoteRequestSchema.parse({
          orderId: session.orderId,
          traceId: session.traceId,
          merchantId: candidate.merchantId,
          capabilityId: candidate.capabilityId,
          intentVersion: intent.version,
          quantity: ["SUPPLY", "TRANSFORM"].includes(candidate.capability.kind)
            ? Math.max(
                intent.quantity,
                ...intent.desiredOutputs
                  .filter((output) =>
                    candidate.capability.produces.some(
                      (port) =>
                        (port.attributes.product ?? port.name) ===
                        (output.attributes.product ?? output.outputId),
                    ),
                  )
                  .map((output) => output.quantity ?? intent.quantity),
              )
            : intent.quantity,
          deadline: intent.deadline,
          currency: intent.currency,
          hardConstraints: intent.hardConstraints,
          softPreferences: intent.softPreferences,
          hold: false,
          actionKey: `${session.orderId}:quote:${intent.version}:${session.planGeneration}:${candidate.capabilityId}`,
        });
        const quote = QuoteResponseSchema.parse(
          await Promise.race([
            this.deps.merchantAgents.quote(request, controller.signal),
            deadline,
          ]),
        );
        if (
          quote.merchantId !== candidate.merchantId ||
          quote.capabilityId !== candidate.capabilityId
        )
          throw new Error("Quote does not match the requested capability");
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
            reason:
              error instanceof DOMException &&
              ["AbortError", "TimeoutError"].includes(error.name)
                ? "The supplier quote did not arrive before its deadline."
                : "The supplier quote could not be retrieved or validated.",
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
    if (
      plan.orderId !== session.orderId ||
      plan.intentVersion !== intent.version
    )
      throw new Error(
        "Solver returned a plan for a different order or intent version",
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
      if (latest.state === "CANCELLED") return latest;
      throw new SupersededSubmissionError("Solver result superseded");
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
      excludedMerchantIds.length
        ? "recovery.plan.ready"
        : "execution.approval.requested",
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
      throw new RequestProblem(
        409,
        "STALE_VERSION",
        "Approval is stale or does not match the active solver plan",
      );
    }
    const approvedPlan = session.activePlan;
    if (session.state === "COMPLETED") return session;
    session = await this.move(session, "EXECUTING", "execution.started");
    let receipt: ExecutionReceipt;
    try {
      receipt = await this.deps.shopify.commit(approvedPlan, session.traceId);
    } catch (error) {
      session.lastErrorCode = "EXECUTION_UNCERTAIN";
      if (error instanceof ExecutionInterruptedError)
        session.executionReceipt = error.receipt;
      return this.move(session, "NEEDS_HUMAN", "execution.failed", "shopify", {
        code: session.lastErrorCode,
        reason:
          "Execution could not confirm every provider effect or supplier acceptance. Retain the receipts and ask the operator to reconcile before further work.",
      });
    }
    session.executionReceipt = receipt;
    if (
      !receipt.compositeProduct ||
      !receipt.customerOrder ||
      receipt.supplierJobs.length !== approvedPlan.nodes.length ||
      receipt.actions.some(
        ({ status }) => !["SUCCEEDED", "COMPENSATED"].includes(status),
      )
    ) {
      session.lastErrorCode = "EXECUTION_INCOMPLETE";
      return this.move(
        session,
        "NEEDS_HUMAN",
        "execution.incomplete",
        "shopify",
        {
          actions: receipt.actions,
          reason:
            "Some execution actions are incomplete. Existing commerce records may remain; operator reconciliation is required.",
        },
      );
    }
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
    const completed = await this.move(session, "COMPLETED", "order.completed");
    const pendingRecovery = (await this.deps.events.list(orderId, 0))
      .reverse()
      .find(
        ({ event }) =>
          event.eventType === "recovery.approval.required" &&
          event.payload.replacementPlanId === approvedPlan.planId,
      );
    if (pendingRecovery)
      await this.emit(completed, "recovery.completed", "orchestrator", {
        ...pendingRecovery.event.payload,
        approvalRequired: false,
      });
    return completed;
  }

  async recoverSupplier(
    orderId: string,
    merchantId: string,
  ): Promise<OrderSession> {
    let session = await this.load(orderId);
    if (
      !["COMPLETED", "AWAITING_APPROVAL", "PLAN_VALIDATED"].includes(
        session.state,
      )
    )
      throw new RequestProblem(
        409,
        "INVALID_TRANSITION",
        "Supplier recovery cannot interrupt active or uncertain execution. Refresh the project and ask the operator to reconcile its effects.",
      );
    const previouslyApproved = session.state === "COMPLETED";
    const previousPlan = session.activePlan;
    if (!previousPlan?.nodes.some((node) => node.merchantId === merchantId)) {
      throw new Error("Supplier is not selected in the active plan");
    }
    await this.emit(
      session,
      "supplier.offline",
      "orchestrator",
      { merchantId },
      merchantId,
    );
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
    if (session.executionReceipt?.planId === previousPlan.planId) {
      try {
        const receipt = await this.deps.shopify.supersede?.(
          orderId,
          previousPlan.planId,
          session.traceId,
        );
        if (receipt) session.executionReceipt = receipt;
      } catch (error) {
        session.lastErrorCode = "EXECUTION_UNCERTAIN";
        if (error instanceof ExecutionInterruptedError)
          session.executionReceipt = error.receipt;
        return this.move(session, "NEEDS_HUMAN", "recovery.failed", "shopify", {
          previousPlanId: previousPlan.planId,
          reason: "Supplier jobs require reconciliation before replacement",
        });
      }
    }
    session = await this.move(
      session,
      "INTENT_COMPILED",
      "recovery.replanning",
      "orchestrator",
    );
    let recovered: OrderSession;
    try {
      recovered = await this.plan(session, [merchantId]);
    } catch (error) {
      return this.failCurrent(session, error, "recovery.failed");
    }
    if (recovered.planGeneration !== session.planGeneration) return recovered;
    const deadline = session.intent?.deadline
      ? new Date(session.intent.deadline).getTime()
      : Number.POSITIVE_INFINITY;
    const completion = recovered.activePlan?.estimatedCompletion
      ? new Date(recovered.activePlan.estimatedCompletion).getTime()
      : Number.POSITIVE_INFINITY;
    if (recovered.activePlan?.status !== "VALID" || completion > deadline) {
      if (recovered.state === "NEEDS_HUMAN") {
        await this.emit(recovered, "recovery.failed", "orchestrator", {
          previousPlanId: previousPlan.planId,
        });
        return recovered;
      }
      return this.move(recovered, "NEEDS_HUMAN", "recovery.failed");
    }
    const recovery = {
      previousPlanId: previousPlan.planId,
      replacementPlanId: recovered.activePlan.planId,
      deadlinePreserved: completion <= deadline,
      costDelta:
        Math.round(
          (recovered.activePlan.totalCost - previousPlan.totalCost) * 100,
        ) / 100,
      currency: recovered.activePlan.currency,
      completionDeltaHours: previousPlan.estimatedCompletion
        ? Math.round(
            (completion - Date.parse(previousPlan.estimatedCompletion)) / 36000,
          ) / 100
        : null,
    };
    if (
      !previouslyApproved ||
      (recovery.costDelta > 0 && recovered.intent?.budgetMax == null)
    ) {
      await this.emit(recovered, "recovery.approval.required", "orchestrator", {
        ...recovery,
        approvalRequired: true,
      });
      return recovered;
    }
    const completed = await this.approve(
      recovered.orderId,
      recovered.activePlan.planId,
      recovered.intentVersion,
    );
    await this.emit(
      completed,
      completed.state === "COMPLETED"
        ? "recovery.completed"
        : "recovery.failed",
      "orchestrator",
      {
        ...recovery,
        approvalRequired: false,
      },
    );
    return completed;
  }
}
