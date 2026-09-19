import type {
  AssetRef,
  DesktopCommand,
  DesktopResult,
  MoleculeEvent,
  MarketplaceSnapshot,
  ContextReceipt,
} from "@molecule/contracts";
import type {
  DesktopBootstrap,
  DesktopBridge,
  OverlayMode,
  SettingsPatch,
} from "../../shared/bridge.js";
import {
  mapEvent,
  subscribeEvents,
  type Activity,
} from "../services/events.js";
import {
  ApiError,
  MoleculeApi,
  validateContext,
} from "../services/molecule-api.js";

export interface PendingOperation {
  actionId: string;
  name: DesktopCommand["name"] | "supplier_offline";
}
export interface UploadResult {
  name: string;
  actionId: string;
  attachActionId: string;
  stage: "upload" | "attach";
  outcome: "confirmed" | "failed" | "unknown";
  contextId?: string;
  error: string | null;
}
interface UploadOperation {
  actionId: string;
  receipt?: ContextReceipt;
  result?: UploadResult;
  pending?: Promise<UploadResult>;
}

function failedUpload(name: string, error: string): UploadResult {
  const actionId = crypto.randomUUID();
  return {
    name,
    actionId,
    attachActionId: `${actionId}:attach`,
    stage: "upload",
    outcome: "failed",
    error,
  };
}

function mergeAttachments(current: AssetRef[], incoming: AssetRef[]) {
  return [
    ...new Map(
      [...current, ...incoming].map((asset) => [asset.assetId, asset]),
    ).values(),
  ];
}

function activeRecovery(
  project: DesktopResult["project"] | null,
  history: MoleculeEvent["payload"][],
  invalidated: ReadonlySet<string>,
) {
  const plan = project?.activePlan;
  if (
    !plan ||
    invalidated.has(plan.planId) ||
    plan.status !== "VALID" ||
    plan.intentVersion !== project.intentVersion ||
    ![
      "AWAITING_APPROVAL",
      "EXECUTING",
      "SKU_CREATED",
      "SUPPLIER_JOBS_CREATED",
      "CUSTOMER_ORDER_CREATED",
      "COMPLETED",
    ].includes(project.state)
  )
    return null;
  return (
    [...history]
      .reverse()
      .find((payload) => payload.replacementPlanId === plan.planId) ?? null
  );
}

export interface DesktopState {
  bootstrap?: DesktopBootstrap;
  mode: OverlayMode;
  visible: boolean;
  project: DesktopResult["project"] | null;
  selectionEpoch: number;
  attachments: AssetRef[];
  uploading: string[];
  uploadResults: UploadResult[];
  activity: Activity[];
  alert: Activity | null;
  failedMerchants: string[];
  failedMerchantHistory: string[];
  recovery: MoleculeEvent["payload"] | null;
  recoveryHistory: MoleculeEvent["payload"][];
  connection: "connecting" | "connected" | "reconnecting" | "offline";
  pending: number;
  pendingOperations: PendingOperation[];
  error: string | null;
  errorDetails: ApiError | null;
  demoMode: boolean;
  mockProviders: string[];
  marketplace: MarketplaceSnapshot | null;
  providerError: string | null;
}

export class DesktopStore {
  private state: DesktopState = {
    mode: "compact",
    visible: false,
    project: null,
    selectionEpoch: 0,
    attachments: [],
    uploading: [],
    uploadResults: [],
    activity: [],
    alert: null,
    failedMerchants: [],
    failedMerchantHistory: [],
    recovery: null,
    recoveryHistory: [],
    connection: "connecting",
    pending: 0,
    pendingOperations: [],
    error: null,
    errorDetails: null,
    demoMode: false,
    mockProviders: [],
    marketplace: null,
    providerError: null,
  };
  private readonly listeners = new Set<() => void>();
  private apiClient?: MoleculeApi;
  private stream?: AbortController;
  private cursor = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private creating?: Promise<DesktopResult>;
  private createActionId = crypto.randomUUID();
  private generation = 0;
  private disposed = false;
  private selection = new AbortController();
  private readonly seenEvents = new Set<string>();
  private readonly commands = new Map<
    string,
    { fingerprint: string; result?: Promise<DesktopResult> }
  >();
  private readonly automaticActions = new Map<string, string>();
  private readonly uploads = new Map<string, UploadOperation>();
  private readonly invalidatedRecoveryPlans = new Set<string>();
  private checking?: Promise<void>;
  private checkingProviders?: Promise<void>;
  private savingSettings = Promise.resolve();
  private capture = new AbortController();
  onBackendEvent?: (event: MoleculeEvent) => void;
  onContextAttached?: () => void;
  onProjectChanging?: () => void;
  constructor(readonly bridge: DesktopBridge) {}
  getSnapshot = () => this.state;
  getCapabilities() {
    const project = this.state.project;
    const planning =
      !project ||
      [
        "REQUESTED",
        "NEEDS_CLARIFICATION",
        "NEEDS_HUMAN",
        "FAILED",
        "COMPILING_INTENT",
        "INTENT_COMPILED",
        "DISCOVERING",
        "CANDIDATES_READY",
        "QUOTING",
        "QUOTED",
        "SOLVING",
        "PLAN_VALIDATED",
        "PLAN_UNSAT",
        "AWAITING_APPROVAL",
      ].includes(project.state);
    const committing = this.state.pendingOperations.some(({ name }) =>
      ["approve_action", "supplier_offline", "cancel_project"].includes(name),
    );
    const mutating = this.state.pendingOperations.some(
      ({ name }) =>
        ![
          "get_project_status",
          "get_active_plan",
          "explain_decision",
          "open_command_center",
        ].includes(name),
    );
    return {
      canSubmitBrief: planning && !committing,
      canCancelPlanning: Boolean(project) && planning && !committing,
      canApprove:
        project?.state === "AWAITING_APPROVAL" &&
        project.activePlan?.status === "VALID" &&
        project.activePlan.intentVersion === project.intentVersion &&
        !mutating,
      canRefresh: Boolean(project),
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(patch: Partial<DesktopState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  get api() {
    if (!this.apiClient) throw new Error("Molecule is starting");
    return this.apiClient;
  }
  error(cause: unknown) {
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    this.patch({
      errorDetails: cause instanceof ApiError ? cause : null,
      error:
        cause instanceof Error
          ? cause.message
          : "Can’t reach Molecule right now.",
    });
  }
  clearError() {
    this.patch({ error: null, errorDetails: null });
  }
  async initialize() {
    try {
      const bootstrap = await this.bridge.bootstrap();
      if (this.disposed) return;
      this.apiClient = new MoleculeApi(bootstrap.apiUrl);
      this.patch({ bootstrap });
      await this.bridge.ready();
      if (this.disposed) return;
      await this.checkConnection();
    } catch (error) {
      this.error(error);
      this.patch({ connection: "offline" });
    }
  }
  checkConnection() {
    if (this.disposed) return Promise.resolve();
    if (this.checking) return this.checking;
    this.checking = this.loadConnection().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }
  private async loadConnection() {
    try {
      const config = await this.api.config();
      if (this.disposed) return;
      this.patch({
        connection: "connected",
        demoMode: config.demoMode,
        mockProviders: Object.entries(config.mockProviders)
          .filter(([, mock]) => mock)
          .map(([name]) => name),
        error: null,
      });
      if (this.state.project) this.connectEvents();
    } catch (error) {
      if (this.disposed) return;
      this.error(error);
      this.patch({ connection: "offline" });
    }
  }
  refreshProviders() {
    if (this.disposed) return Promise.resolve();
    if (this.checkingProviders) return this.checkingProviders;
    this.checkingProviders = this.loadProviders().finally(() => {
      this.checkingProviders = undefined;
    });
    return this.checkingProviders;
  }
  private async loadProviders() {
    try {
      const marketplace = await this.api.marketplace();
      if (this.disposed) return;
      this.patch({ marketplace, providerError: null });
    } catch {
      if (this.disposed) return;
      this.patch({
        marketplace: null,
        providerError:
          "Provider availability is unavailable. Text actions remain available through the backend.",
      });
    }
  }
  setVisible(visible: boolean) {
    if (!visible) {
      this.capture.abort();
      this.capture = new AbortController();
    }
    this.patch({ visible });
  }
  async mode(mode: OverlayMode) {
    this.patch({ mode });
    await this.bridge.setMode(mode);
  }
  settings(settings: SettingsPatch) {
    const save = this.savingSettings
      .catch(() => undefined)
      .then(async () => {
        const bootstrap = await this.bridge.saveSettings(settings);
        if (!this.disposed) this.patch({ bootstrap });
      });
    this.savingSettings = save;
    return save;
  }
  private apply(result: DesktopResult) {
    const current = this.state.project;
    if (current && current.orderId !== result.project.orderId) return;
    const project =
      current && current.revision > result.project.revision
        ? current
        : result.project;
    const recovery = activeRecovery(
      project,
      this.state.recoveryHistory,
      this.invalidatedRecoveryPlans,
    );
    const replaced =
      current?.activePlan?.planId !== project.activePlan?.planId ||
      current?.planGeneration !== project.planGeneration;
    this.patch({
      project,
      attachments: mergeAttachments(this.state.attachments, result.contexts),
      recovery,
      ...(!project.activePlan || (replaced && !recovery)
        ? { failedMerchants: [] }
        : {}),
    });
  }
  async ensureProject(): Promise<DesktopResult> {
    if (this.state.project)
      return { project: this.state.project, contexts: this.state.attachments };
    if (this.creating) return this.creating;
    const generation = this.generation;
    const creating = this.api
      .createProject(this.createActionId)
      .then(async (result) => {
        this.assertCurrent(generation);
        this.createActionId = crypto.randomUUID();
        await this.select(result, generation);
        return result;
      })
      .finally(() => {
        if (this.creating === creating) this.creating = undefined;
      });
    this.creating = creating;
    return this.creating;
  }
  private assertCurrent(generation: number) {
    if (generation !== this.generation)
      throw new DOMException("Project changed", "AbortError");
  }
  private resetProject() {
    this.onProjectChanging?.();
    this.generation += 1;
    this.selection.abort();
    this.selection = new AbortController();
    this.stream?.abort();
    clearTimeout(this.refreshTimer);
    this.creating = undefined;
    this.commands.clear();
    this.automaticActions.clear();
    this.uploads.clear();
    this.invalidatedRecoveryPlans.clear();
    this.seenEvents.clear();
    this.cursor = 0;
    this.createActionId = crypto.randomUUID();
    this.patch({
      project: null,
      selectionEpoch: this.generation,
      attachments: [],
      uploading: [],
      uploadResults: [],
      pending: 0,
      pendingOperations: [],
      activity: [],
      alert: null,
      failedMerchants: [],
      failedMerchantHistory: [],
      recovery: null,
      recoveryHistory: [],
      error: null,
      errorDetails: null,
    });
    this.syncActiveProject(null);
    return this.generation;
  }
  private syncActiveProject(projectId: string | null) {
    const generation = this.generation;
    void this.bridge.setActiveProject?.(projectId).catch(() => {
      if (generation === this.generation)
        this.error(
          new Error(
            "The menu-bar project could not be updated. Open Command Center from this project.",
          ),
        );
    });
  }
  private async select(result: DesktopResult, generation: number) {
    this.assertCurrent(generation);
    this.patch({ project: result.project, attachments: result.contexts });
    this.syncActiveProject(result.project.orderId);
    this.connectEvents();
    const settings = this.state.bootstrap?.settings;
    if (settings)
      await this.settings({
        lastProjectId: result.project.orderId,
      }).catch(() => {
        if (generation === this.generation)
          this.error(
            new Error(
              "Project opened, but the resume preference could not be saved.",
            ),
          );
      });
  }
  async openProject(id: string) {
    const generation = this.resetProject();
    this.patch({ pending: 1 });
    try {
      const result = await this.api.getProject(id, this.selection.signal);
      await this.select(result, generation);
      this.assertCurrent(generation);
      await this.mode("company");
    } finally {
      if (generation === this.generation) this.patch({ pending: 0 });
    }
  }
  async newProject() {
    this.resetProject();
    await this.mode("conversation");
  }
  async refresh(signal?: AbortSignal) {
    const id = this.state.project?.orderId;
    if (!id) return;
    const generation = this.generation;
    const result = await this.api.getProject(
      id,
      signal
        ? AbortSignal.any([signal, this.selection.signal])
        : this.selection.signal,
    );
    if (generation === this.generation) this.apply(result);
  }
  private connectEvents() {
    this.stream?.abort();
    const projectId = this.state.project?.orderId;
    if (!projectId) return;
    const controller = new AbortController();
    const generation = this.generation;
    this.stream = controller;
    void subscribeEvents({
      url: `${this.api.base}/api/orders/${projectId}/events`,
      cursor: this.cursor,
      signal: controller.signal,
      refresh: async (signal) => {
        if (generation === this.generation && !controller.signal.aborted)
          await this.refresh(signal);
      },
      onStatus: (connection) => {
        if (generation === this.generation && !controller.signal.aborted)
          this.patch({ connection });
      },
      onEvent: (event, cursor, replay) => {
        if (generation !== this.generation || controller.signal.aborted) return;
        this.cursor = cursor;
        this.receive(event, replay);
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
          if (generation === this.generation)
            void this.refresh().catch((error) => {
              if (generation === this.generation) this.error(error);
            });
        }, 80);
      },
    });
  }
  receive(event: MoleculeEvent, replay = false) {
    if (
      event.orderId !== this.state.project?.orderId ||
      this.seenEvents.has(event.eventId)
    )
      return;
    this.seenEvents.add(event.eventId);
    if (this.seenEvents.size > 2000)
      this.seenEvents.delete(this.seenEvents.values().next().value!);
    const activity = mapEvent(event);
    if (event.eventType === "supplier.offline") {
      const merchantId =
        event.merchantId ??
        (typeof event.payload.merchantId === "string"
          ? event.payload.merchantId
          : undefined);
      if (merchantId)
        this.patch({
          failedMerchants: [
            ...new Set([...this.state.failedMerchants, merchantId]),
          ],
          failedMerchantHistory: [
            ...new Set([...this.state.failedMerchantHistory, merchantId]),
          ],
          recovery: null,
        });
    }
    if (
      event.eventType === "recovery.completed" ||
      event.eventType === "recovery.approval.required"
    ) {
      const recoveryHistory = [...this.state.recoveryHistory, event.payload];
      this.patch({
        recoveryHistory,
        recovery: activeRecovery(
          this.state.project,
          recoveryHistory,
          this.invalidatedRecoveryPlans,
        ),
      });
    }
    if (
      ["intent.received", "project.cancelled", "recovery.failed"].includes(
        event.eventType,
      ) ||
      (event.eventType === "plan.invalidated" &&
        event.payload.reason !== "supplier_offline")
    ) {
      const planId =
        typeof event.payload.previousPlanId === "string"
          ? event.payload.previousPlanId
          : !replay
            ? this.state.project?.activePlan?.planId
            : undefined;
      if (planId) this.invalidatedRecoveryPlans.add(planId);
      this.patch({ recovery: null, failedMerchants: [] });
    }
    if (!activity) return;
    const redundantAttention =
      event.eventType === "order.needs_human" &&
      [
        "solver.unsat",
        "intent.unsupported",
        "workflow.failed",
        "execution.failed",
        "execution.incomplete",
        "recovery.failed",
      ].includes(this.state.alert?.kind ?? "");
    this.patch({
      activity: [
        ...this.state.activity.filter((item) => item.id !== activity.id),
        activity,
      ].slice(-40),
      alert: redundantAttention
        ? this.state.alert
        : activity.alert
          ? activity
          : [
                "intent.received",
                "plan.invalidated",
                "execution.started",
                "order.completed",
                "project.cancelled",
              ].includes(event.eventType)
            ? null
            : this.state.alert,
    });
    if (!replay) {
      if (activity.alert && this.state.bootstrap?.settings.autoExpandOnAlert)
        void this.mode("alert").catch((error) => this.error(error));
      if (activity.notification && !this.state.visible && !redundantAttention)
        void this.bridge
          .notify({
            eventId: event.eventId,
            projectId: event.orderId ?? "",
            kind: event.eventType,
            label: activity.notification,
          })
          .catch((error) => this.error(error));
      this.onBackendEvent?.(event);
    }
  }
  command(command: DesktopCommand, actionId?: string): Promise<DesktopResult> {
    const fingerprint = JSON.stringify(command);
    const automatic = actionId === undefined;
    actionId ??= this.automaticActions.get(fingerprint) ?? crypto.randomUUID();
    const existing = this.commands.get(actionId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(
          new Error("Action ID reused for a different command."),
        );
      if (existing.result) return existing.result;
    }
    const id = actionId;
    if (automatic) this.automaticActions.set(fingerprint, id);
    const result = this.execute(command, actionId);
    this.commands.set(actionId, { fingerprint, result });
    void result
      .then(
        () => {
          if (
            command.name !== "approve_action" &&
            this.automaticActions.get(fingerprint) === id
          )
            this.automaticActions.delete(fingerprint);
        },
        () => {
          if (this.commands.get(id)?.result === result)
            this.commands.set(id, { fingerprint });
        },
      )
      .finally(() => {
        if (this.commands.size > 500)
          this.commands.delete(this.commands.keys().next().value!);
      })
      .catch(() => undefined);
    return result;
  }
  private async execute(
    command: DesktopCommand,
    actionId: string,
  ): Promise<DesktopResult> {
    const generation = this.generation;
    this.patch({
      pending: this.state.pending + 1,
      error: null,
      errorDetails: null,
      pendingOperations: [
        ...this.state.pendingOperations,
        { actionId, name: command.name },
      ],
    });
    try {
      const { project } = await this.ensureProject();
      this.assertCurrent(generation);
      const result = await this.api.command(project.orderId, command, actionId);
      this.assertCurrent(generation);
      this.apply(result);
      if (command.name === "open_command_center")
        await this.bridge.openDashboard(project.orderId);
      this.assertCurrent(generation);
      return {
        ...result,
        project: this.state.project ?? result.project,
        contexts: this.state.attachments,
      };
    } catch (error) {
      if (generation === this.generation) this.error(error);
      throw error;
    } finally {
      if (generation === this.generation)
        this.patch({
          pending: Math.max(0, this.state.pending - 1),
          pendingOperations: this.state.pendingOperations.filter(
            (operation) => operation.actionId !== actionId,
          ),
        });
    }
  }
  async upload(files: File[]): Promise<UploadResult[]> {
    if (files.length > 8) throw new Error("Attach up to eight files at a time");
    if (!files.length) return [];
    const generation = this.generation;
    const { project } = await this.ensureProject();
    this.assertCurrent(generation);
    const results: UploadResult[] = [];
    for (const file of files) {
      try {
        this.assertCurrent(generation);
        this.patch({
          uploading: [...this.state.uploading, file.name],
        });
        const result = await this.uploadFile(project.orderId, file, generation);
        this.assertCurrent(generation);
        results.push(result);
        const uploadResults = [
          ...this.state.uploadResults.filter(
            (previous) => previous.actionId !== result.actionId,
          ),
          result,
        ];
        const failures = uploadResults.filter(
          (item) => item.outcome !== "confirmed",
        );
        this.patch({
          uploadResults,
          error: failures.length
            ? failures.map((item) => `${item.name}: ${item.error}`).join(" ")
            : null,
        });
      } catch (error) {
        if (generation !== this.generation) return results;
        this.error(error);
      } finally {
        if (generation === this.generation)
          this.patch({
            uploading: this.state.uploading.filter(
              (name) => name !== file.name,
            ),
          });
      }
    }
    return results;
  }
  private async uploadFile(
    projectId: string,
    file: File,
    generation: number,
  ): Promise<UploadResult> {
    let mimeType: string;
    try {
      mimeType = validateContext(file);
    } catch (error) {
      return failedUpload(
        file.name,
        error instanceof Error ? error.message : "Unsupported attachment.",
      );
    }
    let digest: ArrayBuffer;
    try {
      digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    } catch {
      return failedUpload(
        file.name,
        "Could not read this attachment. Select it again.",
      );
    }
    this.assertCurrent(generation);
    const fingerprint = JSON.stringify([
      file.name,
      mimeType,
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ]);
    const operation = this.uploads.get(fingerprint) ?? {
      actionId: crypto.randomUUID(),
    };
    this.uploads.set(fingerprint, operation);
    if (operation.pending) return operation.pending;
    if (operation.result?.outcome === "confirmed") return operation.result;
    operation.pending = this.performUpload(
      projectId,
      file,
      generation,
      operation,
    );
    try {
      operation.result = await operation.pending;
      return operation.result;
    } finally {
      operation.pending = undefined;
    }
  }
  private async performUpload(
    projectId: string,
    file: File,
    generation: number,
    operation: UploadOperation,
  ): Promise<UploadResult> {
    const result: UploadResult = {
      name: file.name,
      actionId: operation.actionId,
      attachActionId: `${operation.actionId}:attach`,
      stage: operation.receipt ? "attach" : "upload",
      outcome: "unknown",
      error: null,
    };
    try {
      operation.receipt ??= await this.api.uploadContext(
        projectId,
        file,
        operation.actionId,
      );
      this.assertCurrent(generation);
      result.stage = "attach";
      result.contextId = operation.receipt.contextId;
      const attached = await this.api.command(
        projectId,
        { name: "attach_context", args: { contextId: result.contextId } },
        result.attachActionId,
      );
      this.assertCurrent(generation);
      this.apply(attached);
      if (
        !this.state.attachments.some(
          (asset) => asset.assetId === result.contextId,
        )
      )
        throw new ApiError(
          "Attachment was not confirmed. Refresh before another attempt.",
          200,
          "INVALID_RESPONSE",
        );
      result.outcome = "confirmed";
      this.onContextAttached?.();
    } catch (error) {
      this.assertCurrent(generation);
      result.error =
        error instanceof ApiError
          ? error.message
          : "Attachment outcome is unknown. Refresh and reconcile before another attempt.";
      if (
        error instanceof ApiError &&
        error.code === "VALIDATION_ERROR" &&
        error.status < 500
      )
        result.outcome = "failed";
      this.patch({ errorDetails: error instanceof ApiError ? error : null });
    }
    return result;
  }
  async uploadFrom(read: (signal: AbortSignal) => Promise<File[]>) {
    const generation = this.generation;
    const signal = AbortSignal.any([
      this.selection.signal,
      this.capture.signal,
    ]);
    const files = await read(signal);
    signal.throwIfAborted();
    this.assertCurrent(generation);
    return this.upload(files);
  }
  async chaos() {
    if (!this.state.demoMode)
      throw new Error("Supplier-offline controls require demo mode.");
    if (this.state.pending > 0) return;
    const generation = this.generation;
    const project = this.state.project;
    const supplier = project?.activePlan?.nodes.find((node) => {
      const candidate = project.candidates.find(
        (item) => item.capabilityId === node.capabilityId,
      );
      return /embroider/i.test(candidate?.capability.name ?? "");
    });
    if (!project || !supplier)
      throw new Error("No embroidery supplier is selected.");
    const fingerprint = JSON.stringify([
      "supplier_offline",
      project.orderId,
      supplier.merchantId,
    ]);
    const actionId =
      this.automaticActions.get(fingerprint) ?? crypto.randomUUID();
    this.automaticActions.set(fingerprint, actionId);
    this.patch({
      pending: this.state.pending + 1,
      pendingOperations: [
        ...this.state.pendingOperations,
        { actionId, name: "supplier_offline" },
      ],
    });
    try {
      const result = await this.api.supplierOffline(
        project.orderId,
        supplier.merchantId,
        actionId,
      );
      this.assertCurrent(generation);
      this.apply(result);
      this.automaticActions.delete(fingerprint);
    } catch (error) {
      if (generation === this.generation) this.error(error);
      throw error;
    } finally {
      if (generation === this.generation)
        this.patch({
          pending: Math.max(0, this.state.pending - 1),
          pendingOperations: this.state.pendingOperations.filter(
            (operation) => operation.actionId !== actionId,
          ),
        });
    }
  }
  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.selection.abort();
    this.stream?.abort();
    clearTimeout(this.refreshTimer);
  }
}
