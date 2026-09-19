/**
 * Merchant-side record of a supplier job decision (accept/decline/ETA),
 * keyed to a plan node. This tracks the Backboard twin's own decision state;
 * it is not the Shopify supplier draft order itself (Person 1 owns that in
 * S5) — orchestrator/Shopify reconcile the two via orderId/nodeId.
 */
export interface JobDecision {
  merchantId: string;
  orderId: string;
  nodeId: string;
  status: "accepted" | "declined";
  reason?: string;
  eta?: string;
  actionKey: string;
  updatedAt: string;
}

export interface AcceptJobInput {
  traceId?: string;
  merchantId: string;
  orderId: string;
  nodeId: string;
  eta?: string;
  actionKey: string;
}

export interface DeclineJobInput {
  traceId?: string;
  merchantId: string;
  orderId: string;
  nodeId: string;
  reason: string;
  actionKey: string;
}

export interface UpdateEtaInput {
  traceId?: string;
  merchantId: string;
  orderId: string;
  nodeId: string;
  eta: string;
  actionKey: string;
}

export class JobNotAcceptedError extends Error {
  constructor(orderId: string, nodeId: string) {
    super(`Job ${orderId}/${nodeId} has not been accepted; cannot update ETA`);
    this.name = "JobNotAcceptedError";
  }
}

export interface JobDecisionStore {
  getDecision(
    merchantId: string,
    orderId: string,
    nodeId: string,
  ): Promise<JobDecision | undefined>;
  acceptJob(input: AcceptJobInput): Promise<JobDecision>;
  declineJob(input: DeclineJobInput): Promise<JobDecision>;
  updateEta(input: UpdateEtaInput): Promise<JobDecision>;
}

export class InMemoryJobDecisionStore implements JobDecisionStore {
  private readonly decisionsByKey = new Map<string, JobDecision>();
  private readonly decisionsByActionKey = new Map<string, JobDecision>();

  private key(merchantId: string, orderId: string, nodeId: string): string {
    return `${merchantId}::${orderId}::${nodeId}`;
  }

  async getDecision(
    merchantId: string,
    orderId: string,
    nodeId: string,
  ): Promise<JobDecision | undefined> {
    return this.decisionsByKey.get(this.key(merchantId, orderId, nodeId));
  }

  async acceptJob(input: AcceptJobInput): Promise<JobDecision> {
    const existing = this.decisionsByActionKey.get(input.actionKey);
    if (existing) {
      return existing;
    }
    const decision: JobDecision = {
      merchantId: input.merchantId,
      orderId: input.orderId,
      nodeId: input.nodeId,
      status: "accepted",
      eta: input.eta,
      actionKey: input.actionKey,
      updatedAt: new Date().toISOString(),
    };
    this.store(decision);
    return decision;
  }

  async declineJob(input: DeclineJobInput): Promise<JobDecision> {
    const existing = this.decisionsByActionKey.get(input.actionKey);
    if (existing) {
      return existing;
    }
    const decision: JobDecision = {
      merchantId: input.merchantId,
      orderId: input.orderId,
      nodeId: input.nodeId,
      status: "declined",
      reason: input.reason,
      actionKey: input.actionKey,
      updatedAt: new Date().toISOString(),
    };
    this.store(decision);
    return decision;
  }

  async updateEta(input: UpdateEtaInput): Promise<JobDecision> {
    const existing = this.decisionsByActionKey.get(input.actionKey);
    if (existing) {
      return existing;
    }
    const current = this.decisionsByKey.get(
      this.key(input.merchantId, input.orderId, input.nodeId),
    );
    if (!current || current.status !== "accepted") {
      throw new JobNotAcceptedError(input.orderId, input.nodeId);
    }
    const decision: JobDecision = {
      ...current,
      eta: input.eta,
      actionKey: input.actionKey,
      updatedAt: new Date().toISOString(),
    };
    this.store(decision);
    return decision;
  }

  private store(decision: JobDecision): void {
    this.decisionsByKey.set(
      this.key(decision.merchantId, decision.orderId, decision.nodeId),
      decision,
    );
    this.decisionsByActionKey.set(decision.actionKey, decision);
  }
}
