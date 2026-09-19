import { createHash, randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import {
  AssetRefSchema,
  CompileIntentRequestSchema,
  SolverInputSchema,
  OrderSessionSnapshotSchema,
} from "@molecule/contracts";
import Fastify from "fastify";
import { z } from "zod";

import type { Config } from "./config.js";
import type { OpenAIClient, SolverClient } from "./clients.js";
import { makeEvent, type EventStore } from "./events/EventStore.js";
import type { SessionRepository } from "./repositories.js";
import { createOrderSession, toSnapshot } from "./session/OrderSession.js";
import { Orchestrator } from "./workflow/Orchestrator.js";
import { registerDesktopRoutes } from "./desktopRoutes.js";
import type { LocalStore } from "./LocalStore.js";
import { ActionLedger } from "./ActionLedger.js";

const MessageBody = z.object({
  text: z.string().min(1),
  locale: z.string().default("en-CA"),
  timeZone: z.string().default("UTC"),
  assets: z.array(AssetRefSchema).default([]),
  correction: z
    .object({
      kind: z.enum([
        "constraint",
        "preference",
        "quantity",
        "deadline",
        "budget",
        "other",
      ]),
      text: z.string().min(1),
    })
    .optional(),
});

export interface ServerDependencies {
  config: Config;
  sessions: SessionRepository;
  events: EventStore;
  orchestrator: Orchestrator;
  solver: SolverClient;
  openai: OpenAIClient;
  desktopStore?: LocalStore;
}

export async function buildServer(deps: ServerDependencies) {
  const app = Fastify({ logger: true });
  const origins = [
    deps.config.ALLOWED_ORIGIN,
    deps.config.DESKTOP_ORIGIN,
    "app://molecule",
  ];
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.origin && !origins.includes(request.headers.origin))
      return reply.code(403).send({ message: "Origin not allowed" });
  });
  await app.register(cors, {
    origin: origins,
    credentials: true,
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready" }));
  registerDesktopRoutes(app, deps);
  const chaosActions = new ActionLedger(deps.desktopStore);

  app.post("/api/intents/compile", async (request) =>
    deps.openai.compileIntent(CompileIntentRequestSchema.parse(request.body)),
  );

  app.post("/api/orders", async (_request, reply) => {
    let session = createOrderSession();
    await deps.sessions.create(session);
    const event = await deps.events.append({
      eventId: randomUUID(),
      traceId: session.traceId,
      orderId: session.orderId,
      eventType: "order.created",
      ts: new Date().toISOString(),
      severity: "INFO",
      source: "orchestrator",
      payload: {},
    });
    session.eventCursor = event.cursor;
    await deps.sessions.save(session, 0);
    return reply.code(201).send(toSnapshot(session));
  });

  app.get<{ Params: { id: string } }>(
    "/api/orders/:id",
    async (request, reply) => {
      const session = await deps.sessions.get(request.params.id);
      return session
        ? toSnapshot(session)
        : reply.code(404).send({ error: "not_found" });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/orders/:id/messages",
    async (request, reply) => {
      const session = await deps.sessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      const body = MessageBody.parse(request.body);
      const input = CompileIntentRequestSchema.parse({
        orderId: session.orderId,
        traceId: session.traceId,
        text: body.text,
        locale: body.locale,
        timeZone: body.timeZone,
        requestedAt: new Date().toISOString(),
        assets: body.assets.length
          ? body.assets
          : (deps.desktopStore
              ?.contexts(request.params.id)
              .filter((item) => item.attached)
              .map((item) => item.asset) ?? []),
        previousIntent: session.intent ?? undefined,
        correction: body.correction,
      });
      return toSnapshot(await deps.orchestrator.submitMessage(input));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/orders/:id/approve",
    async (request, reply) => {
      const body = z
        .object({
          planId: z.string(),
          intentVersion: z.number().int().positive(),
        })
        .parse(request.body);
      try {
        return toSnapshot(
          await deps.orchestrator.approve(
            request.params.id,
            body.planId,
            body.intentVersion,
          ),
        );
      } catch (error) {
        return reply
          .code(409)
          .send({ error: error instanceof Error ? error.message : "conflict" });
      }
    },
  );

  app.post("/api/plans/solve", async (request) =>
    deps.solver.solve(SolverInputSchema.parse(request.body)),
  );

  app.post("/api/execution/commit", async (request) => {
    const body = z
      .strictObject({
        orderId: z.string().min(1),
        planId: z.string().min(1),
        intentVersion: z.number().int().positive(),
      })
      .parse(request.body);
    return toSnapshot(
      await deps.orchestrator.approve(
        body.orderId,
        body.planId,
        body.intentVersion,
      ),
    );
  });

  app.post<{ Params: { id: string } }>(
    "/api/orders/:id/realtime/client-secret",
    async (request, reply) => {
      const session = await deps.sessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      if (!deps.openai.mintRealtimeClientSecret) {
        return reply.code(503).send({ error: "realtime_unavailable" });
      }
      const safetyId = createHash("sha256")
        .update(session.orderId)
        .digest("hex");
      const secret = await deps.openai.mintRealtimeClientSecret(safetyId);
      return { value: secret.value };
    },
  );

  app.post("/api/chaos", async (request, reply) => {
    if (!deps.config.DEMO_MODE)
      return reply.code(404).send({ error: "not_found" });
    const local = ["127.0.0.1", "::1"].includes(request.ip);
    const authorized =
      local ||
      (deps.config.CHAOS_SECRET !== undefined &&
        request.headers["x-chaos-secret"] === deps.config.CHAOS_SECRET);
    if (!authorized) return reply.code(403).send({ error: "forbidden" });
    const body = z
      .object({
        scenario: z.literal("supplier_offline"),
        orderId: z.string(),
        merchantId: z.string(),
        actionId: z.string().min(1).max(160).optional(),
      })
      .parse(request.body);
    const session = await deps.sessions.get(body.orderId);
    if (!session) return reply.code(404).send({ error: "not_found" });
    return chaosActions.run(
      `${body.orderId}:chaos:${body.actionId ?? randomUUID()}`,
      body,
      OrderSessionSnapshotSchema.parse,
      async () => {
        await deps.events.append(
          makeEvent({
            traceId: session.traceId,
            orderId: session.orderId,
            merchantId: body.merchantId,
            eventType: "demo.chaos.triggered",
            source: "ui",
            severity: "WARN",
            payload: { scenario: body.scenario },
          }),
        );
        return toSnapshot(
          await deps.orchestrator.recoverSupplier(
            body.orderId,
            body.merchantId,
          ),
        );
      },
    );
  });

  app.get<{ Params: { id: string } }>(
    "/api/orders/:id/events",
    async (request, reply) => {
      const after = Number(request.headers["last-event-id"] ?? 0);
      if (!(await deps.sessions.get(request.params.id)))
        return reply.code(404).send({ error: "not_found" });
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin":
          request.headers.origin ?? deps.config.ALLOWED_ORIGIN,
        Vary: "Origin",
      });
      const write = ({
        cursor,
        event,
      }: Awaited<ReturnType<EventStore["list"]>>[number]) => {
        reply.raw.write(
          `id: ${cursor}\nevent: molecule\ndata: ${JSON.stringify(event)}\n\n`,
        );
      };
      let replaying = true;
      let last = Number.isFinite(after) ? after : 0;
      const buffered: Awaited<ReturnType<EventStore["list"]>> = [];
      const send = (event: Awaited<ReturnType<EventStore["list"]>>[number]) => {
        if (event.cursor <= last) return;
        last = event.cursor;
        write(event);
      };
      const unsubscribe = deps.events.subscribe(request.params.id, (event) => {
        if (replaying) buffered.push(event);
        else send(event);
      });
      for (const event of await deps.events.list(
        request.params.id,
        Number.isFinite(after) ? after : 0,
      )) {
        send(event);
      }
      for (const event of buffered) send(event);
      replaying = false;
      reply.raw.write("event: ready\ndata: {}\n\n");
      const heartbeat = setInterval(
        () => reply.raw.write(": heartbeat\n\n"),
        15_000,
      );
      reply.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  );

  app.setErrorHandler((error, _request, reply) => {
    const normalized =
      error instanceof Error ? error : new Error("Unknown request error");
    app.log.error({ err: normalized, name: normalized.name }, "request failed");
    void reply
      .code(400)
      .send({ error: normalized.name, message: normalized.message });
  });
  return app;
}
