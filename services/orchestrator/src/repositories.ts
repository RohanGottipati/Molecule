import type { OrderSession } from "./session/OrderSession.js";
import type {
  MoleculeEvent,
  ProjectList,
  ProjectListQuery,
} from "@molecule/contracts";
import { listProjectSnapshots } from "./projectDiscovery.js";

export interface SessionRepository {
  listProjects(query: ProjectListQuery): Promise<ProjectList>;
  create(session: OrderSession): Promise<void>;
  get(orderId: string): Promise<OrderSession | null>;
  save(session: OrderSession, expectedRevision: number): Promise<void>;
  saveWithEvent?(
    session: OrderSession,
    expectedRevision: number,
    event: MoleculeEvent,
  ): Promise<OrderSession>;
}

export class SessionConflictError extends Error {}
export class SupersededSubmissionError extends SessionConflictError {}

export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, OrderSession>();

  async listProjects(query: ProjectListQuery) {
    return listProjectSnapshots([...this.sessions.values()], query);
  }

  async create(session: OrderSession): Promise<void> {
    if (this.sessions.has(session.orderId)) throw new SessionConflictError();
    this.sessions.set(session.orderId, structuredClone(session));
  }

  async get(orderId: string): Promise<OrderSession | null> {
    const session = this.sessions.get(orderId);
    return session ? structuredClone(session) : null;
  }

  async save(session: OrderSession, expectedRevision: number): Promise<void> {
    const current = this.sessions.get(session.orderId);
    if (!current || current.revision !== expectedRevision) {
      throw new SessionConflictError(
        `Expected revision ${expectedRevision}, received ${current?.revision ?? "missing"}`,
      );
    }
    this.sessions.set(session.orderId, structuredClone(session));
  }
}
