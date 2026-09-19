import type {
  AssetRef,
  DesktopCommand,
  DesktopResult,
  MoleculeEvent,
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
  };
  private readonly listeners = new Set<() => void>();
  private apiClient?: MoleculeApi;
  private stream?: AbortController;
  private cursor = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private creating?: Promise<DesktopResult>;
  private createActionId = crypto.randomUUID();
  private generation = 0;
  onBackendEvent?: (event: MoleculeEvent) => void;
  onContextAttached?: () => void;
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
      this.apiClient = new MoleculeApi(bootstrap.apiUrl);
      this.patch({ bootstrap });
      await this.bridge.ready();
      await this.checkConnection();
    } catch (error) {
      this.error(error);
      this.patch({ connection: "offline" });
    }
  }
  async checkConnection() {
    try {
      const config = await this.api.config();
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
      this.error(error);
      this.patch({ connection: "offline" });
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
    this.creating = this.api
      .createProject(this.createActionId)
      .then(async (result) => {
        this.createActionId = crypto.randomUUID();
        await this.select(result);
        return result;
      })
      .finally(() => {
        this.creating = undefined;
      });
    return this.creating;
  }
  private async select(result: DesktopResult) {
    this.generation += 1;
    this.stream?.abort();
    this.cursor = 0;
    this.patch({
      project: result.project,
      attachments: result.contexts,
      activity: [],
      alert: null,
      failedMerchants: [],
      recovery: null,
      error: null,
    });
    const settings = this.state.bootstrap?.settings;
    if (settings)
      await this.settings({
        ...settings,
        lastProjectId: result.project.orderId,
      });
    this.connectEvents();
  }
  async openProject(id: string) {
    await this.select(await this.api.getProject(id));
    await this.mode("company");
  }
  async newProject() {
    if (this.creating) await this.creating;
    this.stream?.abort();
    this.generation += 1;
    this.patch({
      project: null,
      attachments: [],
      activity: [],
      alert: null,
      failedMerchants: [],
      recovery: null,
    });
    this.createActionId = crypto.randomUUID();
    await this.mode("conversation");
  }
  async refresh() {
    const id = this.state.project?.orderId;
    if (!id) return;
    const generation = this.generation;
    const result = await this.api.getProject(id);
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
      refresh: () => this.refresh(),
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
          void this.refresh().catch((error) => this.error(error));
        }, 80);
      },
    });
  }
  receive(event: MoleculeEvent, replay = false) {
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
  async command(
    command: DesktopCommand,
    actionId: string = crypto.randomUUID(),
  ): Promise<DesktopResult> {
    this.patch({ pending: this.state.pending + 1, error: null });
    try {
      const { project } = await this.ensureProject();
      if (command.name === "open_command_center")
        await this.bridge.openDashboard(project.orderId);
      const result = await this.api.command(project.orderId, command, actionId);
      this.apply(result);
      return result;
    } catch (error) {
      this.error(error);
      throw error;
    } finally {
      this.patch({ pending: Math.max(0, this.state.pending - 1) });
    }
  }
  async upload(files: File[]) {
    if (files.length > 8) throw new Error("Attach up to eight files at a time");
    for (const file of files) {
      try {
        validateContext(file);
        this.patch({
          uploading: [...this.state.uploading, file.name],
          error: null,
        });
        const { project } = await this.ensureProject();
        const actionId = crypto.randomUUID();
        const context = await this.api.uploadContext(
          project.orderId,
          file,
          actionId,
        );
        const result = await this.api.command(
          project.orderId,
          { name: "attach_context", args: { contextId: context.contextId } },
          `${actionId}:attach`,
        );
        this.apply(result);
        this.onContextAttached?.();
      } catch (error) {
        this.error(error);
      } finally {
        this.patch({
          uploading: this.state.uploading.filter((name) => name !== file.name),
        });
      }
    }
  }
  async chaos() {
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
      this.apply(
        await this.api.supplierOffline(
          project.orderId,
          supplier.merchantId,
          crypto.randomUUID(),
        ),
      );
    } finally {
      this.patch({ pending: Math.max(0, this.state.pending - 1) });
    }
  }
  dispose() {
    this.stream?.abort();
    clearTimeout(this.refreshTimer);
  }
}
