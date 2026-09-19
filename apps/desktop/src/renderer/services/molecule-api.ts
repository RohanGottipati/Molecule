import {
  ContextReceiptSchema,
  DesktopCommandSchema,
  DesktopResultSchema,
  MAX_CONTEXT_BYTES,
  MarketplaceSnapshotSchema,
  RealtimeSessionSchema,
  type DesktopCommand,
  type DesktopResult,
} from "@molecule/contracts";
import { z } from "zod";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
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
          const body = z
            .object({
              message: z.string().optional(),
              error: z.string().optional(),
            })
            .safeParse(await response.json().catch(() => null));
          throw new ApiError(
            body.success && response.status < 500
              ? (body.data.message ?? body.data.error ?? "Request failed")
              : `Molecule request failed (${response.status}). Please retry.`,
            response.status,
          );
        }
        try {
          return (await response.json()) as unknown;
        } catch {
          throw new ApiError(
            "Molecule returned an invalid response.",
            response.status,
          );
        }
      } catch (error) {
        if (init.signal?.aborted)
          throw new DOMException("Request cancelled", "AbortError");
        if (error instanceof ApiError || attempt === 2) {
          if (error instanceof ApiError) throw error;
          throw new ApiError("Can’t reach Molecule right now.", 0);
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
  async config() {
    return DesktopConfigSchema.parse(await this.request("/api/desktop/config"));
  }
  async marketplace() {
    return MarketplaceSnapshotSchema.parse(
      await this.request("/api/marketplace"),
    );
  }
  async createProject(actionId: string = crypto.randomUUID()) {
    return DesktopResultSchema.parse(
      await this.post("/api/projects", { actionId, source: "desktop" }),
    );
  }
  async getProject(id: string, signal?: AbortSignal) {
    return DesktopResultSchema.parse(
      await this.request(`/api/projects/${encodeURIComponent(id)}`, { signal }),
    );
  }
  async command(
    id: string,
    command: DesktopCommand,
    actionId: string,
  ): Promise<DesktopResult> {
    return DesktopResultSchema.parse(
      await this.post(`/api/projects/${encodeURIComponent(id)}/actions`, {
        actionId,
        command: DesktopCommandSchema.parse(command),
        locale: navigator.language || "en-CA",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    );
  }
  async createRealtimeSession(projectId: string) {
    return RealtimeSessionSchema.parse(
      await this.post("/api/desktop/realtime-session", { projectId }),
    );
  }
  async uploadContext(projectId: string, file: File, actionId: string) {
    const mimeType = validateContext(file);
    return ContextReceiptSchema.parse(
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
