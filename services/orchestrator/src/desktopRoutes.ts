import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ActionIdSchema,
  ContextReceiptSchema,
  ContextUploadSchema,
  DesktopActionSchema,
  DesktopResultSchema,
  MAX_CONTEXT_BYTES,
  type DesktopResult,
} from "@molecule/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ActionLedger } from "./ActionLedger.js";
import { RequestProblem } from "./errors.js";
import { makeEvent } from "./events/EventStore.js";
import { LocalStore } from "./LocalStore.js";
import type { ServerDependencies } from "./server.js";
import { createOrderSession, toSnapshot } from "./session/OrderSession.js";

export function registerDesktopRoutes(
  app: FastifyInstance,
  deps: ServerDependencies,
  actions = new ActionLedger(deps.desktopStore),
) {
  const store = deps.desktopStore ?? new LocalStore();
  const result = async (orderId: string): Promise<DesktopResult> => {
    const session = await deps.sessions.get(orderId);
    if (!session)
      throw new RequestProblem(
        404,
        "NOT_FOUND",
        "Project not found. Check the link or start a new project.",
      );
    return {
      project: toSnapshot(session),
      contexts: (await store.contexts(orderId))
        .filter((item) => item.attached)
        .map((item) => item.asset),
    };
  };
  app.get("/api/desktop/config", async () => ({
    demoMode: deps.config.DEMO_MODE,
    demoResetAvailable: deps.config.DEMO_MODE && Boolean(deps.resetDemo),
    mockProviders: {
      openai: deps.config.USE_MOCK_OPENAI,
      reality: deps.config.STORAGE_MODE === "local" || deps.config.DEMO_MODE,
      merchants: deps.config.BACKBOARD_MODE === "demo",
      shopify: deps.config.SHOPIFY_MODE === "demo",
    },
    maxContextBytes: MAX_CONTEXT_BYTES,
  }));
  app.post("/api/projects", async (request, reply) => {
    const body = z
      .object({ actionId: ActionIdSchema, source: z.literal("desktop") })
      .parse(request.body);
    const created = await actions.run(
      `create:${body.actionId}`,
      body,
      DesktopResultSchema.parse,
      async () => {
        const session = createOrderSession();
        await deps.sessions.create(session);
        await deps.events.append(
          makeEvent({
            traceId: session.traceId,
            orderId: session.orderId,
            eventType: "order.created",
            source: "ui",
            payload: { actionId: body.actionId },
          }),
        );
        return result(session.orderId);
      },
    );
    return reply.code(201).send(created);
  });
  app.get<{ Params: { id: string } }>("/api/projects/:id", (request) =>
    result(request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/actions",
    async (request) => {
      const body = DesktopActionSchema.parse(request.body);
      const id = z.uuid().parse(request.params.id);
      await result(id);
      return actions.run(
        `${id}:${body.actionId}`,
        body,
        DesktopResultSchema.parse,
        async () => {
          const { command } = body;
          switch (command.name) {
            case "start_project": {
              const session = (await result(id)).project;
              await deps.orchestrator.submitMessage(
                {
                  orderId: id,
                  traceId: session.traceId,
                  text: command.args.intent,
                  requestedAt: new Date().toISOString(),
                  locale: body.locale,
                  timeZone: body.timeZone,
                  assets: (await store.contexts(id))
                    .filter((item) => item.attached)
                    .map((item) => item.asset),
                },
                {
                  messageId: body.actionId,
                  source: "desktop",
                  expectedRevision: body.expectedRevision,
                  originalText: body.originalText,
                },
              );
              break;
            }
            case "add_constraint":
            case "remove_constraint":
            case "request_recompile":
              await deps.orchestrator.revise(
                id,
                command,
                body.actionId,
                body.originalText,
                body.expectedRevision,
              );
              break;
            case "approve_action":
              await deps.orchestrator.approve(
                id,
                command.args.planId,
                command.args.intentVersion,
              );
              break;
            case "cancel_project":
              await deps.orchestrator.cancel(id);
              break;
            case "attach_context": {
              await store.attachContext(id, command.args.contextId);
              break;
            }
            case "get_project_status":
            case "get_active_plan":
            case "explain_decision":
            case "open_command_center":
              break;
          }
          return result(id);
        },
      );
    },
  );
  app.post("/api/desktop/realtime-session", async (request, reply) => {
    const { projectId } = z.object({ projectId: z.uuid() }).parse(request.body);
    await result(projectId);
    if (!deps.openai.mintRealtimeClientSecret)
      return reply
        .code(503)
        .send({ message: "Voice is unavailable. You can keep using text." });
    reply.header("Cache-Control", "no-store");
    return deps.openai.mintRealtimeClientSecret(
      createHash("sha256").update(projectId).digest("hex"),
      "desktop",
    );
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_CONTEXT_BYTES },
    (_request, body, done) => done(null, body),
  );
  app.post<{ Params: { id: string }; Body: Buffer }>(
    "/api/projects/:id/context",
    { bodyLimit: MAX_CONTEXT_BYTES },
    async (request) => {
      const id = z.uuid().parse(request.params.id);
      const { project } = await result(id);
      const metadata = ContextUploadSchema.parse({
        actionId: request.headers["x-action-id"],
        mimeType: request.headers["x-file-type"],
        name: decodeURIComponent(
          z.string().parse(request.headers["x-file-name"]),
        ),
      });
      if (/[\\/\x00-\x1f]/u.test(metadata.name))
        throw new RequestProblem(
          400,
          "VALIDATION_ERROR",
          "Use a filename without slashes or control characters.",
        );
      const bytes = request.body;
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.length === 0 ||
        bytes.length > MAX_CONTEXT_BYTES
      )
        throw new RequestProblem(
          400,
          "VALIDATION_ERROR",
          "File must be between 1 byte and 10 MB.",
        );
      const extensions: Record<typeof metadata.mimeType, RegExp> = {
        "image/png": /\.png$/i,
        "image/jpeg": /\.jpe?g$/i,
        "application/pdf": /\.pdf$/i,
        "text/csv": /\.csv$/i,
        "text/plain": /\.txt$/i,
        "application/json": /\.json$/i,
      };
      if (!extensions[metadata.mimeType].test(metadata.name))
        throw new RequestProblem(
          400,
          "VALIDATION_ERROR",
          "The filename extension must match its supported file type.",
        );
      if (
        (metadata.mimeType === "image/png" &&
          bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") ||
        (metadata.mimeType === "image/jpeg" &&
          bytes.subarray(0, 3).toString("hex") !== "ffd8ff") ||
        (metadata.mimeType === "application/pdf" &&
          bytes.subarray(0, 5).toString() !== "%PDF-")
      )
        throw new RequestProblem(
          400,
          "VALIDATION_ERROR",
          "File contents do not match its type.",
        );
      const checksum = createHash("sha256").update(bytes).digest("hex");
      return actions.run(
        `${id}:upload:${metadata.actionId}`,
        { ...metadata, checksum },
        ContextReceiptSchema.parse,
        async () => {
          const contextId = randomUUID();
          const providerFileId = await deps.openai.uploadContext?.({
            bytes,
            name: metadata.name,
            mimeType: metadata.mimeType,
            traceId: project.traceId,
            actionKey: metadata.actionId,
          });
          const asset = {
            assetId: contextId,
            name: metadata.name,
            mimeType: metadata.mimeType,
            checksum,
            providerFileId,
          };
          if (store.directory)
            await writeFile(
              join(store.directory, `${contextId}.context`),
              bytes,
              { mode: 0o600, flag: "wx" },
            );
          await store.saveContext(
            { orderId: id, asset, attached: false },
            bytes,
          );
          await deps.events.append(
            makeEvent({
              traceId: project.traceId,
              orderId: id,
              source: "orchestrator",
              eventType: "context.uploaded",
              payload: { contextId, mimeType: metadata.mimeType },
            }),
          );
          return { contextId, asset };
        },
      );
    },
  );
}
