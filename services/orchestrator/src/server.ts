import { createHash, randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import {
  ActionIdSchema,
  ActionStatusQuerySchema,
  ProjectListQuerySchema,
  ProjectListSchema,
  MessageHistoryQuerySchema,
  ProjectCapabilitiesEnvelopeSchema,
  MessageSubmissionSchema,
  BriefClarificationRequestSchema,
  BriefClarificationResultSchema,
  CompileIntentRequestSchema,
  SolverInputSchema,
  OrderSessionSnapshotSchema,
  MarketplaceSnapshotSchema,
  type MarketplaceSnapshot,
  type ChaosRequest,
} from "@molecule/contracts";
import {
  handleShopifyWebhook,
  ShopifyError,
  type WebhookOptions,
} from "@molecule/shopify";
import Fastify from "fastify";
import { z } from "zod";

import type { Config } from "./config.js";
import type { OpenAIClient, SolverClient } from "./clients.js";
import { makeEvent, type EventStore } from "./events/EventStore.js";
import type { SessionRepository } from "./repositories.js";
import { createOrderSession, toSnapshot } from "./session/OrderSession.js";
import { Orchestrator } from "./workflow/Orchestrator.js";
import { registerDesktopRoutes } from "./desktopRoutes.js";
import { chaosAuthorized } from "./demoAuthorization.js";
import type { ContextStore } from "./LocalStore.js";
import { ActionLedger } from "./ActionLedger.js";
import { apiFailure, RequestProblem } from "./errors.js";
import { readMessageHistory } from "./messageHistory.js";

const SHOPIFY_WEBHOOK_PATH = "/api/shopify/webhooks";

function singleValueHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value,
    ]),
  );
}

function shopifyWebhookStatus(error: ShopifyError): number {
  if (error.code === "WEBHOOK_UNAUTHORIZED") return 401;
  if (error.code === "WEBHOOK_TOO_LARGE") return 413;
  if (
    error.code === "PERSISTENCE_FAILED" ||
    error.code === "PERSISTENCE_DISCONNECTED"
  )
    return 503;
  return 400;
}

export interface ServerDependencies {
  readiness?: () => Promise<{ solver: boolean; persistence: boolean }>;
  catalogGallery?: () => Promise<import("@molecule/contracts").CatalogGallery>;
  config: Config;
  sessions: SessionRepository;
  events: EventStore;
  orchestrator: Orchestrator;
  solver: SolverClient;
  openai: OpenAIClient;
  desktopStore?: ContextStore;
  marketplace?: () => Promise<MarketplaceSnapshot>;
  applyChaos?: (request: ChaosRequest, traceId: string) => Promise<void>;
  resetDemo?: () => Promise<void>;
  shopifyWebhook?: {
    options: WebhookOptions;
    ingestInventoryUpdate?: (input: {
      shop: string;
      inventoryItemId: string | number;
      locationId?: string | number;
      available: number;
      observedAt?: string;
      traceId: string;
    }) => Promise<void>;
  };
}

export async function buildServer(deps: ServerDependencies) {
  const app = Fastify({ logger: true });
  app.get("/api/catalog/recipes", async () =>
    deps.catalogGallery
      ? deps.catalogGallery()
      : { catalogVersion: null, recipes: [] },
  );
  if (deps.shopifyWebhook) {
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (request, body, done) => {
        if (request.url.split("?")[0] === SHOPIFY_WEBHOOK_PATH) {
          done(null, body);
          return;
        }
        try {
          done(null, JSON.parse(body.toString("utf8")));
        } catch {
          done(
            new RequestProblem(
              400,
              "VALIDATION_ERROR",
              "Request body must contain valid JSON",
            ),
            undefined,
          );
        }
      },
    );
  }
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
  app.get("/ready", async (_request, reply) => {
    const checks = await deps.readiness?.().catch(() => undefined);
    const ready = checks?.solver === true && checks.persistence === true;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "unavailable",
      checks: checks ?? { solver: false, persistence: false },
    });
  });
  if (deps.shopifyWebhook) {
    app.post(
      SHOPIFY_WEBHOOK_PATH,
      { bodyLimit: deps.shopifyWebhook.options.maxBodyBytes ?? 1_000_000 },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body))
          throw new ShopifyError("WEBHOOK_INVALID_PAYLOAD");
        try {
          const result = await handleShopifyWebhook(
            deps.shopifyWebhook!.options,
            {
              rawBody: request.body,
              headers: singleValueHeaders(request.headers),
            },
          );
          if (
            result.topic === "inventory_levels/update" &&
            result.payload.inventory_item_id !== undefined &&
            result.payload.available !== undefined &&
            result.payload.available !== null
          ) {
            try {
              await deps.shopifyWebhook!.ingestInventoryUpdate?.({
                shop: result.domain,
                inventoryItemId: result.payload.inventory_item_id,
                locationId: result.payload.location_id,
                available: result.payload.available,
                ...(result.triggeredAt
                  ? { observedAt: result.triggeredAt }
                  : {}),
                traceId: `shopify-webhook:${result.deliveryId}`,
              });
            } catch {
              throw new ShopifyError("PERSISTENCE_FAILED");
            }
          }
          return reply.code(200).send({
            status: result.status,
            eventId: result.eventId,
          });
        } catch (error) {
          if (error instanceof ShopifyError)
            return reply.code(shopifyWebhookStatus(error)).send({
              error: error.code,
            });
          throw error;
        }
      },
    );
  }
  const chaosActions = new ActionLedger(deps.desktopStore);
  registerDesktopRoutes(app, deps, chaosActions);
  app.get("/api/projects", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return ProjectListSchema.parse(
      await deps.sessions.listProjects(
        ProjectListQuerySchema.parse(request.query),
      ),
    );
  });
  app.get<{ Params: { id: string } }>(
    "/api/orders/:id/messages",
    async (request, reply) => {
      if (!(await deps.sessions.get(request.params.id)))
        return reply.code(404).send({ error: "not_found" });
      const query = MessageHistoryQuerySchema.parse(request.query);
      reply.header("Cache-Control", "no-store");
      return readMessageHistory(
        deps.events,
        request.params.id,
        query.afterCursor,
        query.limit,
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/orders/:id/actions",
    async (request, reply) => {
      if (!(await deps.sessions.get(request.params.id)))
        return reply.code(404).send({ error: "not_found" });
      reply.header("Cache-Control", "no-store");
      return chaosActions.status(
        request.params.id,
        ActionStatusQuerySchema.parse(request.query),
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/orders/:id/capabilities",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return ProjectCapabilitiesEnvelopeSchema.parse(
        await deps.orchestrator.capabilities(request.params.id),
      );
    },
  );
  app.get("/api/marketplace", async (_request, reply) => {
    try {
      if (!deps.marketplace)
        return reply.code(503).send({ message: "Marketplace is unavailable" });
      return MarketplaceSnapshotSchema.parse(await deps.marketplace());
    } catch (error) {
      _request.log.warn(
        {
          scope: "marketplace",
          event: "marketplace.failed",
          reason: error instanceof Error ? error.message : "unknown",
        },
        "Marketplace snapshot failed",
      );
      return reply.code(503).send({ message: "Marketplace temporarily unavailable" });
    }
  });

  app.post("/api/intents/compile", async (request) =>
    deps.openai.compileIntent(CompileIntentRequestSchema.parse(request.body)),
  );

  app.post("/api/briefs/clarify", async (request) =>
    BriefClarificationResultSchema.parse(
      await deps.openai.clarifyBrief(
        BriefClarificationRequestSchema.parse(request.body),
      ),
    ),
  );

  app.post("/api/orders", async (request, reply) => {
    const actionId = ActionIdSchema.parse(
      request.headers["x-action-id"] ?? randomUUID(),
    );
    const result = await chaosActions.run(
      `order:create:${actionId}`,
      {},
      OrderSessionSnapshotSchema.parse,
      async () => {
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
        return toSnapshot(session);
      },
    );
    return reply.code(201).send(result);
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
      const body = MessageSubmissionSchema.parse(request.body);
      const messageId = ActionIdSchema.parse(
        request.headers["x-action-id"] ?? randomUUID(),
      );
      const input = CompileIntentRequestSchema.parse({
        orderId: session.orderId,
        traceId: session.traceId,
        text: body.text,
        locale: body.locale,
        timeZone: body.timeZone,
        requestedAt: new Date().toISOString(),
        assets: body.assets.length
          ? body.assets
          : ((await deps.desktopStore?.contexts(request.params.id))
              ?.filter((item) => item.attached)
              .map((item) => item.asset) ?? []),
        previousIntent: session.intent ?? undefined,
        correction: body.correction,
      });
      return chaosActions.run(
        `${session.orderId}:message:${messageId}`,
        body,
        OrderSessionSnapshotSchema.parse,
        async () =>
          toSnapshot(
            await deps.orchestrator.submitMessage(input, {
              messageId,
              source: "web",
              expectedRevision: body.expectedRevision,
            }),
          ),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/orders/:id/approve",
    async (request) => {
      const body = z
        .object({
          planId: z.string(),
          intentVersion: z.number().int().positive(),
        })
        .parse(request.body);
      return chaosActions.run(
        `${request.params.id}:approve:${body.planId}:${body.intentVersion}`,
        body,
        OrderSessionSnapshotSchema.parse,
        async () =>
          toSnapshot(
            await deps.orchestrator.approve(
              request.params.id,
              body.planId,
              body.intentVersion,
            ),
          ),
      );
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
      const id = z.uuid().parse(request.params.id);
      const session = await deps.sessions.get(id);
      if (!session)
        throw new RequestProblem(
          404,
          "NOT_FOUND",
          "Project not found. Check the link or start a new project.",
        );
      if (!deps.openai.mintRealtimeClientSecret)
        throw new RequestProblem(
          503,
          "VOICE_UNAVAILABLE",
          "Voice is unavailable. You can keep using text.",
        );
      reply.header("Cache-Control", "no-store");
      try {
        const secret = await deps.openai.mintRealtimeClientSecret(
          createHash("sha256").update(session.orderId).digest("hex"),
        );
        return { value: secret.value, expiresAt: secret.expiresAt };
      } catch (error) {
        request.log.warn(
          {
            scope: "voice",
            event: "realtime_session.failed",
            reason: error instanceof Error ? error.name : "unknown",
          },
          "Realtime session minting failed",
        );
        throw new RequestProblem(
          503,
          "VOICE_UNAVAILABLE",
          "Voice is unavailable. You can keep using text.",
        );
      }
    },
  );

  app.post("/api/chaos", async (request, reply) => {
    if (!deps.config.DEMO_MODE)
      return reply.code(404).send({ error: "not_found" });
    if (!chaosAuthorized(deps.config, request))
      return reply.code(403).send({ error: "forbidden" });
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
        if (
          !session.activePlan?.nodes.some(
            (node) => node.merchantId === body.merchantId,
          )
        )
          throw new Error("Supplier is not selected in the active plan");
        await deps.applyChaos?.(
          {
            scenario: body.scenario,
            orderId: body.orderId,
            merchantId: body.merchantId,
          },
          session.traceId,
        );
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
  app.post("/api/demo/reset", async (request, reply) => {
    if (!deps.config.DEMO_MODE || !deps.resetDemo)
      return reply.code(404).send({ error: "not_found" });
    if (!chaosAuthorized(deps.config, request))
      return reply.code(403).send({ error: "forbidden" });
    await deps.resetDemo();
    return {
      status: "reset",
      scope: "synthetic marketplace; order audit history retained",
    };
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

  app.setErrorHandler((error, request, reply) => {
    const normalized =
      error instanceof Error ? error : new Error("Unknown request error");
    const trace = request.headers["x-trace-id"];
    const failure = apiFailure(
      normalized,
      typeof trace === "string" && trace ? trace.slice(0, 160) : request.id,
    );
    const details = {
      name: normalized.name,
      code: failure.body.code,
      traceId: failure.body.traceId,
    };
    if (failure.status >= 500) app.log.error(details, "request failed");
    else app.log.warn(details, "request rejected");
    void reply.code(failure.status).send(failure.body);
  });
  return app;
}
