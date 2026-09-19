import type {
  AssetRef,
  DesktopCommand,
  DesktopResult,
  MoleculeEvent,
  MarketplaceSnapshot,
} from "@molecule/contracts";
import type {
  DesktopBootstrap,
  DesktopBridge,
  OverlayMode,
  Settings,
} from "../../shared/bridge.js";
import {
  mapEvent,
  subscribeEvents,
  type Activity,
} from "../services/events.js";
import { MoleculeApi, validateContext } from "../services/molecule-api.js";

export interface DesktopState {
  bootstrap?: DesktopBootstrap;
  mode: OverlayMode;
  visible: boolean;
  project: DesktopResult["project"] | null;
  attachments: AssetRef[];
  uploading: string[];
  activity: Activity[];
  alert: Activity | null;
  failedMerchants: string[];
  recovery: MoleculeEvent["payload"] | null;
  connection: "connecting" | "connected" | "reconnecting" | "offline";
  pending: number;
  error: string | null;
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
    attachments: [],
    uploading: [],
    activity: [],
    alert: null,
    failedMerchants: [],
    recovery: null,
    connection: "connecting",
    pending: 0,
    error: null,
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
  private checking?: Promise<void>;
  private checkingProviders?: Promise<void>;
  onBackendEvent?: (event: MoleculeEvent) => void;
  onContextAttached?: () => void;
  onProjectChanging?: () => void;
  constructor(readonly bridge: DesktopBridge) {}
  getSnapshot = () => this.state;
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
      error:
        cause instanceof Error
          ? cause.message
          : "Can’t reach Molecule right now.",
    });
  }
  clearError() {
    this.patch({ error: null });
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
    this.patch({ visible });
  }
  async mode(mode: OverlayMode) {
    this.patch({ mode });
    await this.bridge.setMode(mode);
  }
  async settings(settings: Settings) {
    const bootstrap = await this.bridge.saveSettings(settings);
    this.patch({ bootstrap });
  }
  private apply(result: DesktopResult) {
    const current = this.state.project;
    if (current && current.orderId !== result.project.orderId) return;
    if (current && current.revision > result.project.revision) return;
    this.patch({ project: result.project, attachments: result.contexts });
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
    this.seenEvents.clear();
    this.cursor = 0;
    this.createActionId = crypto.randomUUID();
    this.patch({
      project: null,
      attachments: [],
      uploading: [],
      pending: 0,
      activity: [],
      alert: null,
      failedMerchants: [],
      recovery: null,
      error: null,
    });
    return this.generation;
  }
  private async select(result: DesktopResult, generation: number) {
    this.assertCurrent(generation);
    this.patch({ project: result.project, attachments: result.contexts });
    this.connectEvents();
    const settings = this.state.bootstrap?.settings;
    if (settings)
      await this.settings({
        ...settings,
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
          recovery: null,
        });
    }
    if (
      event.eventType === "recovery.completed" ||
      event.eventType === "recovery.approval.required"
    )
      this.patch({ recovery: event.payload });
    if (!activity) return;
    this.patch({
      activity: [
        ...this.state.activity.filter((item) => item.id !== activity.id),
        activity,
      ].slice(-40),
      alert: activity.alert ? activity : this.state.alert,
    });
    if (!replay) {
      if (activity.alert && this.state.bootstrap?.settings.autoExpandOnAlert)
        void this.mode("alert").catch((error) => this.error(error));
      if (activity.notification)
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
          if (this.automaticActions.get(fingerprint) === id)
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
    this.patch({ pending: this.state.pending + 1, error: null });
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
        this.patch({ pending: Math.max(0, this.state.pending - 1) });
    }
  }
  async upload(files: File[]) {
    if (files.length > 8) throw new Error("Attach up to eight files at a time");
    if (!files.length) return;
    files.forEach(validateContext);
    const generation = this.generation;
    const { project } = await this.ensureProject();
    this.assertCurrent(generation);
    for (const file of files) {
      try {
        this.assertCurrent(generation);
        this.patch({
          uploading: [...this.state.uploading, file.name],
          error: null,
        });
        const actionId = crypto.randomUUID();
        const context = await this.api.uploadContext(
          project.orderId,
          file,
          actionId,
        );
        this.assertCurrent(generation);
        const result = await this.api.command(
          project.orderId,
          { name: "attach_context", args: { contextId: context.contextId } },
          `${actionId}:attach`,
        );
        this.assertCurrent(generation);
        this.apply(result);
        this.onContextAttached?.();
      } catch (error) {
        if (generation !== this.generation) return;
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
  }
  async uploadFrom(read: () => Promise<File[]>) {
    const generation = this.generation;
    const files = await read();
    this.assertCurrent(generation);
    await this.upload(files);
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
    this.patch({ pending: this.state.pending + 1 });
    try {
      const result = await this.api.supplierOffline(
        project.orderId,
        supplier.merchantId,
        crypto.randomUUID(),
      );
      this.assertCurrent(generation);
      this.apply(result);
    } finally {
      if (generation === this.generation)
        this.patch({ pending: Math.max(0, this.state.pending - 1) });
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
