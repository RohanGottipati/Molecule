"use client";

import type {
  MarketplaceSnapshot,
  OrderSessionSnapshot,
  ProductionPlan,
} from "@molecule/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  approvePlan,
  cancelPlanning,
  createOrder,
  fileMetadata,
  getActionStatus,
  getMarketplace,
  submitMessagePayload,
  triggerChaos,
  uploadContext,
} from "./api";
import { readDemoConfiguration } from "./configuration";
import { parseWorkspaceLocation, projectHref } from "./navigation";
import {
  isUnresolved,
  newDraftScope,
  readDraft,
  readPending,
  saveDraft,
  savePending,
  type DraftScope,
  type PendingAction,
} from "./persistence";
import {
  conversationEntries,
  reconcileAction,
  resumeCreatedAction,
  safeCapabilities,
} from "./synchronization";
import { useProjectDiscovery } from "./useProjectDiscovery";
import { useProjectSync } from "./useProjectSync";
import { mergeSnapshot, type WorkspaceView } from "./workspace";

export type { ConversationEntry } from "./synchronization";
export type { Connection } from "./useProjectSync";
export type WorkspaceOperation =
  "brief" | "approval" | "recovery" | "upload" | "cancel" | null;

function message(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The request could not be completed.";
}

async function digest(value: ArrayBuffer | string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  );
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function useWorkspace(initialOrderId?: string) {
  const [orderId, setOrderId] = useState<string | null>(initialOrderId ?? null);
  const activeId = useRef<string | null>(initialOrderId ?? null);
  const generation = useRef(0);
  const orderRef = useRef<OrderSessionSnapshot | null>(null);
  const [order, setOrder] = useState<OrderSessionSnapshot | null>(null);
  const [previousPlan, setPreviousPlan] = useState<ProductionPlan | null>(null);
  const [view, setView] = useState<WorkspaceView>("command");
  const scopeRef = useRef<DraftScope>(
    initialOrderId ? `project:${initialOrderId}` : "new:uninitialized",
  );
  const [draftScope, setDraftScope] = useState(scopeRef.current);
  const actionRef = useRef<PendingAction | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [storageError, setStorageError] = useState<string | null>(null);
  const [operation, setOperation] = useState<WorkspaceOperation>(null);
  const operationRef = useRef<WorkspaceOperation>(null);
  const [error, setError] = useState<string | null>(null);
  const [marketplace, setMarketplace] = useState<MarketplaceSnapshot | null>(
    null,
  );
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
  const [marketplaceLoading, setMarketplaceLoading] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const demoEnabled = useRef(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const marketRead = useRef<Promise<void> | null>(null);
  const configRead = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const discovery = useProjectDiscovery();

  const remember = useCallback(
    (action: PendingAction | null, scope = scopeRef.current) => {
      if (!savePending(scope, action) && mounted.current)
        setStorageError(
          "Browser storage is unavailable. Keep this page open while the action outcome is uncertain.",
        );
      if (scope === scopeRef.current && mounted.current) {
        actionRef.current = action;
        setPendingAction(action);
      }
    },
    [],
  );
  const settle = useCallback(
    (action: PendingAction, scope: DraftScope) => {
      const saved = readPending(scope);
      if (
        (saved && saved.key !== action.key) ||
        (scope === scopeRef.current && actionRef.current?.key !== action.key)
      )
        return;
      remember(action, scope);
    },
    [remember],
  );
  const apply = useCallback((next: OrderSessionSnapshot) => {
    if (!mounted.current || activeId.current !== next.orderId) return false;
    const current = orderRef.current;
    const merged = mergeSnapshot(current, next, next.orderId);
    if (merged === current) return true;
    if (
      current?.activePlan &&
      current.activePlan.planId !== next.activePlan?.planId
    )
      setPreviousPlan(current.activePlan);
    orderRef.current = merged;
    setOrder(merged);
    return true;
  }, []);
  const reconcile = useCallback(
    async (signal?: AbortSignal) => {
      const action = actionRef.current;
      if (
        !action?.orderId ||
        action.orderId !== activeId.current ||
        action.kind === "create" ||
        action.kind === "recovery" ||
        !isUnresolved(action)
      )
        return;
      const started = generation.current;
      const scope = scopeRef.current;
      const status = await getActionStatus(
        action.orderId,
        { kind: action.kind, key: action.key },
        signal,
      );
      if (
        signal?.aborted ||
        generation.current !== started ||
        actionRef.current?.key !== action.key
      )
        return;
      remember(reconcileAction(actionRef.current, status), scope);
      if (status.error) setError(status.error.message);
      else if (status.status === "succeeded") setError(null);
    },
    [remember],
  );
  const refreshMarketplace = useCallback(
    (signal?: AbortSignal): Promise<void> => {
      if (marketRead.current) return marketRead.current;
      setMarketplaceLoading(true);
      marketRead.current = getMarketplace(signal)
        .then((snapshot) => {
          if (!mounted.current || signal?.aborted) return;
          setMarketplace((current) =>
            current && current.generatedAt > snapshot.generatedAt
              ? current
              : snapshot,
          );
          setMarketplaceError(null);
        })
        .catch((cause: unknown) => {
          if (mounted.current && !signal?.aborted)
            setMarketplaceError(message(cause));
        })
        .finally(() => {
          marketRead.current = null;
          if (mounted.current) setMarketplaceLoading(false);
        });
      return marketRead.current;
    },
    [],
  );
  const refreshConfig = useCallback((signal?: AbortSignal): Promise<void> => {
    if (configRead.current) return configRead.current;
    configRead.current = readDemoConfiguration((state) => {
      if (!mounted.current) return;
      setDemoMode(state.enabled);
      demoEnabled.current = state.enabled;
      setConfigLoading(state.loading);
      setConfigError(state.error);
    }, signal).finally(() => {
      configRead.current = null;
    });
    return configRead.current;
  }, []);
  const refreshGlobals = useCallback(() => {
    void refreshMarketplace();
    void refreshConfig();
    void discovery.refreshProjects();
  }, [refreshMarketplace, refreshConfig, discovery.refreshProjects]);
  const sync = useProjectSync(orderId, apply, reconcile, refreshGlobals);
  const contexts = sync.capabilities?.orderId === orderId ? sync.contexts : [];
  const capabilities = safeCapabilities(
    order,
    sync.capabilities,
    sync.freshness,
    contexts,
    operation !== null || isUnresolved(pendingAction),
  );
  const changeProject = useCallback(
    (id: string | null, scope?: DraftScope) => {
      generation.current++;
      activeId.current = id;
      orderRef.current = null;
      const nextScope: DraftScope =
        scope ?? (id ? `project:${id}` : newDraftScope());
      scopeRef.current = nextScope;
      setDraftScope(nextScope);
      const action = readPending(nextScope);
      actionRef.current = action;
      setPendingAction(action);
      setOrderId(id);
      setOrder(null);
      setPreviousPlan(null);
      setError(null);
      operationRef.current = null;
      setOperation(null);
      sync.freshnessRef.current = id ? "loading" : "idle";
    },
    [sync.freshnessRef],
  );
  useEffect(() => {
    mounted.current = true;
    const syncUrl = () => {
      const location = parseWorkspaceLocation(
        window.location.pathname,
        window.location.search,
      );
      setView(location.view);
      if (
        location.orderId !== activeId.current ||
        scopeRef.current === "new:uninitialized"
      )
        changeProject(location.orderId);
      else {
        const action = readPending(scopeRef.current);
        actionRef.current = action;
        setPendingAction(action);
      }
    };
    syncUrl();
    refreshGlobals();
    window.addEventListener("popstate", syncUrl);
    return () => {
      mounted.current = false;
      window.removeEventListener("popstate", syncUrl);
    };
  }, [changeProject, refreshGlobals]);
  const navigate = useCallback((next: WorkspaceView) => {
    setView(next);
    const href = projectHref(activeId.current, next, window.location.search);
    if (href !== `${window.location.pathname}${window.location.search}`)
      window.history.pushState(null, "", href);
  }, []);
  const openProject = useCallback(
    (id: string, nextView?: WorkspaceView) => {
      const selected =
        nextView ??
        parseWorkspaceLocation(window.location.pathname, window.location.search)
          .view;
      if (id !== activeId.current) changeProject(id);
      setView(selected);
      const href = projectHref(id, selected, window.location.search);
      if (href !== `${window.location.pathname}${window.location.search}`)
        window.history.pushState(null, "", href);
    },
    [changeProject],
  );
  const newProject = useCallback(() => {
    changeProject(null, newDraftScope(true));
    setView("command");
    window.history.pushState(null, "", "/");
  }, [changeProject]);
  function begin(kind: WorkspaceOperation) {
    if (operationRef.current) return false;
    operationRef.current = kind;
    setOperation(kind);
    setError(null);
    return true;
  }
  function finish(started: number) {
    if (mounted.current && generation.current === started) {
      operationRef.current = null;
      setOperation(null);
      sync.invalidate();
    }
  }
  async function send(text: string): Promise<boolean> {
    if (!text.trim() || operationRef.current) return false;
    let action = actionRef.current;
    if (
      action?.payload?.text === text &&
      (action.kind === "message" || action.kind === "create")
    ) {
      if (action.status === "succeeded") return true;
      if (action.status === "failed" || action.status === "superseded") {
        setError(
          "This request was not completed. Review its outcome and edit the brief before submitting a new request.",
        );
        return false;
      }
    } else {
      if (isUnresolved(action)) {
        setError(
          "Resolve the previous action before submitting another request.",
        );
        return false;
      }
      if (
        activeId.current &&
        !safeCapabilities(
          orderRef.current,
          sync.capabilities,
          sync.freshnessRef.current,
          contexts,
        ).canSubmitMessage
      ) {
        setError("Wait for a fresh project read before editing this brief.");
        return false;
      }
      const current = orderRef.current;
      const key = `${current ? "message" : "create"}:${crypto.randomUUID()}`;
      action = {
        key,
        orderId: current?.orderId ?? null,
        traceId: current?.traceId ?? key,
        kind: current ? "message" : "create",
        status: "unknown",
        payload: {
          text,
          assets: [...contexts],
          locale: navigator.language || "en-CA",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(current ? { expectedRevision: current.revision } : {}),
          ...(current?.intent ? { correction: { kind: "other", text } } : {}),
        },
      };
      remember(action);
    }
    if (!action?.payload || !begin("brief")) return false;
    const started = generation.current;
    let scope = scopeRef.current;
    try {
      if (action.kind === "create") {
        const current = await createOrder(action.key);
        const nextScope: DraftScope = `project:${current.orderId}`;
        const payload = action.payload;
        if (!payload) return false;
        const create = action;
        action = resumeCreatedAction(create, current, readPending(nextScope));
        remember(action, nextScope);
        saveDraft(nextScope, readDraft(scope) || payload.text);
        remember(
          { ...create, orderId: current.orderId, payload: action.payload },
          scope,
        );
        if (generation.current !== started || !mounted.current) return false;
        scope = nextScope;
        scopeRef.current = scope;
        setDraftScope(scope);
        activeId.current = current.orderId;
        setOrderId(current.orderId);
        apply(current);
        actionRef.current = action;
        setPendingAction(action);
        window.history.replaceState(
          null,
          "",
          projectHref(current.orderId, view, window.location.search),
        );
      }
      if (!action.orderId || !action.payload) return false;
      if (generation.current !== started || !mounted.current) return false;
      const status = await getActionStatus(action.orderId, {
        kind: "message",
        key: action.key,
      });
      action = reconcileAction(action, status);
      settle(action, scope);
      if (generation.current !== started || !mounted.current) return false;
      if (status.status === "succeeded") {
        await sync.refresh();
        return generation.current === started;
      }
      if (status.status !== "unknown") {
        setError(
          status.error?.message ??
            "This action is pending or requires review. Refresh to check its outcome.",
        );
        return false;
      }
      if (!action.payload || !action.orderId) return false;
      const next = await submitMessagePayload(
        { orderId: action.orderId, traceId: action.traceId },
        action.payload,
        action.key,
      );
      settle({ ...action, status: "succeeded" }, scope);
      if (generation.current !== started || !mounted.current) return false;
      apply(next);
      void discovery.refreshProjects();
      return true;
    } catch (cause) {
      if (generation.current === started && mounted.current)
        setError(message(cause));
      return false;
    } finally {
      finish(started);
    }
  }
  async function act(
    kind: "approval" | "cancel" | "recovery",
    merchantId?: string,
  ) {
    const current = orderRef.current;
    const allowed = safeCapabilities(
      current,
      sync.capabilities,
      sync.freshnessRef.current,
      contexts,
      isUnresolved(actionRef.current),
    );
    if (
      !current ||
      operationRef.current ||
      (kind === "approval" && !allowed.canApprove) ||
      (kind === "cancel" && !allowed.canCancelPlanning) ||
      (kind === "recovery" &&
        (!demoEnabled.current ||
          sync.freshnessRef.current !== "fresh" ||
          isUnresolved(actionRef.current)))
    ) {
      setError(
        "This action is unavailable. Refresh and review the current project first.",
      );
      return;
    }
    if (!begin(kind)) return;
    const started = generation.current;
    const scope = scopeRef.current;
    const action: PendingAction = {
      kind:
        kind === "approval"
          ? "approve"
          : kind === "cancel"
            ? "desktop"
            : "recovery",
      key:
        kind === "approval"
          ? `${current.activePlan!.planId}:${current.intentVersion}`
          : kind === "cancel"
            ? `cancel:${current.orderId}:${current.revision}`
            : `offline:${current.orderId}:${current.activePlan?.planId}:${merchantId}`,
      orderId: current.orderId,
      traceId: current.traceId,
      payload: null,
      status: "unknown",
    };
    if (kind !== "cancel") remember(action);
    try {
      const next =
        kind === "approval"
          ? await approvePlan(current)
          : kind === "cancel"
            ? (
                await cancelPlanning(current, action.key, () =>
                  remember(action, scope),
                )
              ).project
            : await triggerChaos(
                current,
                merchantId!,
                "supplier_offline",
                action.key,
              );
      settle({ ...action, status: "succeeded" }, scope);
      if (generation.current === started) {
        apply(next);
        refreshGlobals();
      }
    } catch (cause) {
      if (generation.current === started) setError(message(cause));
    } finally {
      finish(started);
    }
  }
  async function upload(file: File) {
    const current = orderRef.current;
    if (
      !current ||
      operationRef.current ||
      isUnresolved(actionRef.current) ||
      !safeCapabilities(
        current,
        sync.capabilities,
        sync.freshnessRef.current,
        contexts,
      ).canSubmitMessage
    ) {
      setError("Wait for a fresh, editable project before attaching context.");
      return;
    }
    if (!begin("upload")) return;
    const started = generation.current;
    const scope = scopeRef.current;
    try {
      fileMetadata(file, "validate-upload");
      const identity = await digest(
        JSON.stringify([
          file.name,
          file.type,
          await digest(await file.arrayBuffer()),
        ]),
      );
      if (generation.current !== started) return;
      const action: PendingAction = {
        key: `upload:${current.orderId}:${identity}`,
        orderId: current.orderId,
        traceId: current.traceId,
        kind: "upload",
        payload: null,
        status: "unknown",
      };
      remember(action);
      let attached = action;
      const result = await uploadContext(
        current,
        file,
        action.key,
        (contextId) => {
          attached = { ...action, key: `attach:${contextId}`, kind: "desktop" };
          remember(attached, scope);
        },
      );
      settle({ ...attached, status: "succeeded" }, scope);
      if (generation.current === started) apply(result.project);
    } catch (cause) {
      if (generation.current === started) setError(message(cause));
    } finally {
      finish(started);
    }
  }
  return {
    ...discovery,
    orderId,
    order,
    previousPlan,
    view,
    events: sync.events.filter((event) => event.orderId === orderId),
    contexts,
    conversation: conversationEntries(
      sync.capabilities?.orderId === orderId ? sync.history.messages : [],
      pendingAction,
    ),
    historyLoading: sync.historyLoading,
    historyNextCursor: sync.history.nextCursor,
    loadMoreHistory: sync.loadMoreHistory,
    marketplace,
    marketplaceError,
    marketplaceLoading,
    demoMode,
    configError,
    configLoading,
    busy: operation !== null,
    operation,
    loading: !!orderId && (sync.loading || (!order && !sync.syncError)),
    error: error ?? sync.syncError,
    syncError: sync.syncError,
    storageError,
    connection: sync.connection,
    freshness: sync.freshness,
    lastSyncedAt: sync.lastSyncedAt,
    capabilities,
    canSubmitMessage: !orderId
      ? !operation && !isUnresolved(pendingAction)
      : capabilities.canSubmitMessage,
    canApprove: capabilities.canApprove,
    canCancelPlanning: capabilities.canCancelPlanning,
    pendingAction,
    draftScope,
    navigate,
    openProject,
    newProject,
    refresh: sync.refresh,
    refreshMarketplace,
    refreshConfig,
    send,
    upload,
    retryPending: () =>
      actionRef.current?.payload
        ? send(actionRef.current.payload.text)
        : sync.refresh(),
    approve: () => act("approval"),
    cancelPlanning: () => act("cancel"),
    offline: (merchantId: string) => act("recovery", merchantId),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
