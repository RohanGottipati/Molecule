import {
  ApiErrorSchema,
  ContextReceiptSchema,
  DesktopCommandSchema,
  DesktopResultSchema,
  MAX_CONTEXT_BYTES,
  MarketplaceSnapshotSchema,
  RealtimeSessionSchema,
  type DesktopCommand,
  type DesktopResult,
  type ApiError as ApiFailure,
} from "@molecule/contracts";
import { z } from "zod";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code:
      | ApiFailure["code"]
      | "REQUEST_FAILED"
      | "NETWORK_ERROR"
      | "INVALID_RESPONSE" = "REQUEST_FAILED",
    readonly traceId?: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
const guidance: Record<ApiFailure["code"], string> = {
  VALIDATION_ERROR: "Check the request fields and supported file types.",
  CONFLICT:
    "The action conflicts with the current project or an existing receipt. Refresh and review its outcome before continuing.",
  STALE_VERSION:
    "The plan changed. Refresh and review the current plan before approving.",
  NOT_FOUND:
    "The project or context is unavailable. Check the selected project.",
  PROVIDER_TIMEOUT:
    "The provider timed out. Refresh the project and check its outcome before another attempt.",
  PROVIDER_AUTH:
    "The provider could not authenticate. Ask the operator to check its configuration.",
  RATE_LIMITED:
    "The provider is busy. Wait briefly, then refresh and check the action outcome.",
  MODEL_REFUSAL:
    "The model could not process this request. Review the production brief.",
  INCOMPLETE_MODEL_OUTPUT:
    "The model response was incomplete. Refresh the project before continuing.",
  SOLVER_UNSAT:
    "No solver-valid plan satisfies the current requirements. Review the constraints.",
  INVALID_TRANSITION:
    "The project cannot accept this action now. Refresh its status.",
  CHAOS_DISABLED: "Supplier-offline controls require demo mode.",
  INTERNAL:
    "The service could not complete this action. Refresh and review its outcome.",
};
export const DesktopConfigSchema = z.object({
  demoMode: z.boolean(),
  mockProviders: z.record(z.string(), z.boolean()),
  maxContextBytes: z.number(),
});

export class MoleculeApi {
  constructor(
    readonly base: string,
    private readonly transport: typeof fetch = (...args) =>
      globalThis.fetch(...args),
  ) {}
  private async request(path: string, init: RequestInit = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        init.signal?.throwIfAborted();
        const response = await this.transport(`${this.base}${path}`, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            ...(init.signal ? [init.signal] : []),
            AbortSignal.timeout(init.method === "POST" ? 120_000 : 15_000),
          ]),
        });
        if (!response.ok) {
          const body = ApiErrorSchema.safeParse(
            await response.json().catch(() => null),
          );
          throw new ApiError(
            body.success
              ? guidance[body.data.code]
              : `Molecule request failed (${response.status}). Refresh and review the action outcome before continuing.`,
            response.status,
            body.success ? body.data.code : "REQUEST_FAILED",
            body.success ? body.data.traceId : undefined,
            body.success ? body.data.retryable : undefined,
          );
        }
        try {
          return (await response.json()) as unknown;
        } catch {
          throw new ApiError(
            "Molecule returned an invalid response. Refresh and review the action outcome.",
            response.status,
            "INVALID_RESPONSE",
          );
        }
      } catch (error) {
        if (init.signal?.aborted)
          throw new DOMException("Request cancelled", "AbortError");
        if (error instanceof ApiError || attempt === 2) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(
            "Can’t reach Molecule right now. Refresh and check whether the action completed before continuing.",
            0,
            "NETWORK_ERROR",
          );
        }
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            init.signal?.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 300 * 2 ** attempt);
          init.signal?.addEventListener("abort", finish, { once: true });
          if (init.signal?.aborted) finish();
        });
      }
    }
  }
  private post(path: string, value: unknown) {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new ApiError(
        "Molecule returned an invalid response. Refresh and review the action outcome.",
        200,
        "INVALID_RESPONSE",
      );
    return result.data;
  }
  async config() {
    return this.parse(
      DesktopConfigSchema,
      await this.request("/api/desktop/config"),
    );
  }
  async marketplace() {
    return this.parse(
      MarketplaceSnapshotSchema,
      await this.request("/api/marketplace"),
    );
  }
  async createProject(actionId: string = crypto.randomUUID()) {
    return this.parse(
      DesktopResultSchema,
      await this.post("/api/projects", { actionId, source: "desktop" }),
    );
  }
  async getProject(id: string, signal?: AbortSignal) {
    return this.parse(
      DesktopResultSchema,
      await this.request(`/api/projects/${encodeURIComponent(id)}`, { signal }),
    );
  }
  async command(
    id: string,
    command: DesktopCommand,
    actionId: string,
    expectedRevision?: number,
  ): Promise<DesktopResult> {
    return this.parse(
      DesktopResultSchema,
      await this.post(`/api/projects/${encodeURIComponent(id)}/actions`, {
        actionId,
        command: DesktopCommandSchema.parse(command),
        expectedRevision,
        locale: navigator.language || "en-CA",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    );
  }
  async createRealtimeSession(projectId: string) {
    return this.parse(
      RealtimeSessionSchema,
      await this.post("/api/desktop/realtime-session", { projectId }),
    );
  }
  async uploadContext(projectId: string, file: File, actionId: string) {
    const mimeType = validateContext(file);
    return this.parse(
      ContextReceiptSchema,
      await this.request(
        `/api/projects/${encodeURIComponent(projectId)}/context`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name),
            "X-File-Type": mimeType,
            "X-Action-Id": actionId,
          },
          body: file,
        },
      ),
    );
  }
  async supplierOffline(orderId: string, merchantId: string, actionId: string) {
    await this.post("/api/chaos", {
      orderId,
      merchantId,
      actionId,
      scenario: "supplier_offline",
    });
    return this.getProject(orderId);
  }
}

const contentTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
};
export function validateContext(file: File) {
  if (file.name.length > 255 || /[\\/\x00-\x1f\x7f]/u.test(file.name))
    throw new Error("Choose a file with a valid filename.");
  const mimeType =
    contentTypes[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!mimeType) throw new Error("That file type isn’t supported yet.");
  if (file.size === 0 || file.size > MAX_CONTEXT_BYTES)
    throw new Error("Choose a file between 1 byte and 10 MB.");
  return mimeType;
}
