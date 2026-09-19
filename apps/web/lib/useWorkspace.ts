"use client";

import type {
  AssetRef,
  MarketplaceSnapshot,
  MoleculeEvent,
  OrderSessionSnapshot,
  ProductionPlan,
} from "@molecule/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  approvePlan,
  createOrder,
  fileMetadata,
  getContexts,
  getDemoMode,
  getMarketplace,
  getOrder,
  submitMessage,
  triggerChaos,
  uploadContext,
} from "./api";
import { subscribeEvents } from "./events";
import {
  canEditBrief,
  mergeContexts,
  mergeEvents,
  mergeSnapshot,
  parseView,
  type WorkspaceView,
} from "./workspace";

export type ConversationEntry = {
  id: string;
  text: string;
  status: "sending" | "confirmed" | "unconfirmed";
};
export type Connection =
  "idle" | "connecting" | "connected" | "reconnecting" | "invalid";

function message(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The request could not be completed.";
}

async function digest(value: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function useWorkspace(initialOrderId?: string) {
  const [orderId, setOrderId] = useState<string | null>(initialOrderId ?? null);
  const activeId = useRef<string | null>(initialOrderId ?? null);
  const orderRef = useRef<OrderSessionSnapshot | null>(null);
  const createKey = useRef<string | null>(null);
  const pending = useRef(false);
  const [order, setOrder] = useState<OrderSessionSnapshot | null>(null);
  const [previousPlan, setPreviousPlan] = useState<ProductionPlan | null>(null);
  const [view, setView] = useState<WorkspaceView>("command");
  const [events, setEvents] = useState<MoleculeEvent[]>([]);
  const [contexts, setContexts] = useState<AssetRef[]>([]);
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [marketplace, setMarketplace] = useState<MarketplaceSnapshot | null>(
    null,
  );
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
  const [marketplaceLoading, setMarketplaceLoading] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [operation, setOperation] = useState<
    "brief" | "approval" | "recovery" | "upload" | null
  >(null);
  const busy = operation !== null;
  const [loading, setLoading] = useState(Boolean(initialOrderId));
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("idle");

  const apply = useCallback((next: OrderSessionSnapshot) => {
    if (activeId.current !== next.orderId) return;
    const current = orderRef.current;
    const merged = mergeSnapshot(current, next, next.orderId);
    if (merged === current) return;
    if (
      current?.activePlan &&
      current.activePlan.planId !== next.activePlan?.planId
    )
      setPreviousPlan(current.activePlan);
    orderRef.current = merged;
    setOrder(merged);
  }, []);

  const refreshMarketplace = useCallback(async (signal?: AbortSignal) => {
    setMarketplaceLoading(true);
    try {
      const snapshot = await getMarketplace(signal);
      if (signal?.aborted) return;
      setMarketplace((current) =>
        current && current.generatedAt > snapshot.generatedAt
          ? current
          : snapshot,
      );
      setMarketplaceError(null);
    } catch (cause) {
      if (!signal?.aborted) setMarketplaceError(message(cause));
    } finally {
      if (!signal?.aborted) setMarketplaceLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const id = activeId.current;
    if (!id) return;
    try {
      apply(await getOrder(id));
      const result = await getContexts(id);
      if (id === activeId.current) {
        apply(result.project);
        setContexts((current) => mergeContexts(current, result.contexts));
      }
      if (id === activeId.current) {
        setError(null);
        setSyncError(null);
      }
    } catch (cause) {
      if (id === activeId.current) setSyncError(message(cause));
    }
  }, [apply]);

  const refreshConfig = useCallback(async (signal?: AbortSignal) => {
    setConfigLoading(true);
    await getDemoMode(signal)
      .then((enabled) => {
        if (!signal?.aborted) {
          setDemoMode(enabled);
          setConfigError(null);
        }
      })
      .catch(() => {
        if (!signal?.aborted)
          setConfigError(
            "Demo configuration unavailable. Recovery controls are disabled.",
          );
      })
      .finally(() => {
        if (!signal?.aborted) setConfigLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshMarketplace(controller.signal);
    void refreshConfig(controller.signal);
    return () => controller.abort();
  }, [refreshMarketplace, refreshConfig]);

  const changeProject = useCallback((id: string | null) => {
    activeId.current = id;
    orderRef.current = null;
    setOrderId(id);
    setOrder(null);
    setEvents([]);
    setContexts([]);
    setConversation([]);
    setPreviousPlan(null);
    setError(null);
    setSyncError(null);
    setConnection(id ? "connecting" : "idle");
    setLoading(Boolean(id));
    createKey.current = null;
  }, []);

  useEffect(() => {
    const syncUrl = () => {
      const match = /^\/projects\/([^/]+)\/?$/.exec(window.location.pathname);
      const id = match?.[1] ? decodeURIComponent(match[1]) : null;
      setView(
        parseView(new URLSearchParams(window.location.search).get("view")),
      );
      if (id !== activeId.current) changeProject(id);
    };
    syncUrl();
    window.addEventListener("popstate", syncUrl);
    return () => window.removeEventListener("popstate", syncUrl);
  }, [changeProject]);

  const navigate = useCallback((next: WorkspaceView) => {
    setView(next);
    const path = activeId.current
      ? `/projects/${encodeURIComponent(activeId.current)}`
      : "/";
    window.history.pushState(
      null,
      "",
      next === "command" ? path : `${path}?view=${next}`,
    );
  }, []);

  const newProject = useCallback(() => {
    if (pending.current) return;
    changeProject(null);
    setView("command");
    window.history.pushState(null, "", "/");
  }, [changeProject]);

  useEffect(() => {
    if (!orderId) return;
    const controller = new AbortController();
    const id = orderId;
    setLoading(true);
    setConnection("connecting");
    void getOrder(id, controller.signal)
      .then(async (snapshot) => {
        if (controller.signal.aborted || activeId.current !== id) return;
        apply(snapshot);
        try {
          const result = await getContexts(id, controller.signal);
          if (!controller.signal.aborted && activeId.current === id) {
            apply(result.project);
            setContexts((current) => mergeContexts(current, result.contexts));
          }
        } catch {
          if (!controller.signal.aborted)
            setError(
              "Project attachments could not be loaded. Refresh before submitting a request that depends on them.",
            );
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setSyncError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const seen = new Set<string>();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let marketplaceTimer: ReturnType<typeof setTimeout> | undefined;
    let streamConnected = false;
    const queueRefresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void getOrder(id, controller.signal)
          .then((snapshot) => {
            if (controller.signal.aborted) return;
            apply(snapshot);
            setSyncError(null);
          })
          .catch((cause) => {
            if (!controller.signal.aborted) setSyncError(message(cause));
          });
      }, 150);
    };
    const unsubscribe = subscribeEvents(id, {
      onReady: () => {
        streamConnected = true;
        setConnection("connected");
        queueRefresh();
      },
      onInvalid: () => {
        streamConnected = false;
        setConnection("invalid");
        queueRefresh();
      },
      onEvent: (event) => {
        if (seen.has(event.eventId)) return;
        seen.add(event.eventId);
        setEvents((current) => mergeEvents(current, [event]));
        queueRefresh();
        clearTimeout(marketplaceTimer);
        marketplaceTimer = setTimeout(
          () => void refreshMarketplace(controller.signal),
          1_500,
        );
      },
      onReconnect: () => {
        streamConnected = false;
        setConnection("reconnecting");
      },
    });
    const poll = setInterval(() => {
      if (!streamConnected) queueRefresh();
    }, 10_000);
    return () => {
      controller.abort();
      unsubscribe();
      clearInterval(poll);
      clearTimeout(refreshTimer);
      clearTimeout(marketplaceTimer);
    };
  }, [orderId, apply, refreshMarketplace]);

  async function send(text: string) {
    if (pending.current || !text.trim()) return false;
    if (!canEditBrief(orderRef.current)) {
      setError(
        "This project is not accepting brief changes. Wait for the current action, or start a new project after execution.",
      );
      return false;
    }
    pending.current = true;
    setOperation("brief");
    setError(null);
    const startingId = activeId.current;
    let operationId = startingId;
    const localId = crypto.randomUUID();
    setConversation((current) => [
      ...current,
      { id: localId, text, status: "sending" },
    ]);
    try {
      let current = orderRef.current;
      if (!current) {
        if (startingId)
          throw new Error(
            "Wait for this project to load or start a new project.",
          );
        createKey.current ??= `create:${crypto.randomUUID()}`;
        current = await createOrder(createKey.current);
        if (activeId.current !== startingId) return false;
        operationId = current.orderId;
        activeId.current = current.orderId;
        setOrderId(current.orderId);
        apply(current);
        const selectedView = parseView(
          new URLSearchParams(window.location.search).get("view"),
        );
        const path = `/projects/${encodeURIComponent(current.orderId)}`;
        window.history.replaceState(
          null,
          "",
          selectedView === "command" ? path : `${path}?view=${selectedView}`,
        );
      }
      const id = current.orderId;
      const key = `message:${id}:${current.intentVersion}:${current.planGeneration}:${await digest(text.trim())}`;
      const next = await submitMessage(
        current,
        text.trim(),
        key,
        [],
        current.intent ? { kind: "other", text: text.trim() } : undefined,
      );
      apply(next);
      if (activeId.current === id)
        setConversation((entries) =>
          entries.map((entry) =>
            entry.id === localId ? { ...entry, status: "confirmed" } : entry,
          ),
        );
      return activeId.current === id;
    } catch (cause) {
      if (activeId.current === operationId) {
        setError(message(cause));
        setConversation((entries) =>
          entries.map((entry) =>
            entry.id === localId ? { ...entry, status: "unconfirmed" } : entry,
          ),
        );
      }
      return false;
    } finally {
      pending.current = false;
      setOperation(null);
    }
  }

  async function act(
    action: (current: OrderSessionSnapshot) => Promise<OrderSessionSnapshot>,
    kind: "approval" | "recovery",
  ) {
    if (pending.current || !orderRef.current) return;
    const current = orderRef.current;
    pending.current = true;
    setOperation(kind);
    setError(null);
    try {
      apply(await action(current));
      void refreshMarketplace();
    } catch (cause) {
      if (activeId.current === current.orderId) setError(message(cause));
    } finally {
      pending.current = false;
      setOperation(null);
    }
  }

  async function upload(file: File) {
    if (pending.current || !orderRef.current) return;
    const current = orderRef.current;
    pending.current = true;
    setOperation("upload");
    setError(null);
    try {
      fileMetadata(file, "validate-upload");
      const hash = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      const checksum = [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const identity = await digest(
        JSON.stringify([file.name, file.type, checksum]),
      );
      const result = await uploadContext(
        current,
        file,
        `upload:${current.orderId}:${identity}`,
      );
      if (activeId.current === current.orderId) {
        apply(result.project);
        setContexts((attached) => mergeContexts(attached, result.contexts));
      }
    } catch (cause) {
      if (activeId.current === current.orderId) setError(message(cause));
    } finally {
      pending.current = false;
      setOperation(null);
    }
  }

  return {
    orderId,
    order,
    previousPlan,
    view,
    events,
    contexts,
    conversation,
    marketplace,
    marketplaceError,
    marketplaceLoading,
    demoMode,
    configError,
    configLoading,
    busy,
    operation,
    loading,
    error: error ?? syncError,
    connection,
    navigate,
    newProject,
    refresh,
    refreshMarketplace,
    refreshConfig,
    send,
    upload,
    approve: () => act(approvePlan, "approval"),
    offline: (merchantId: string) =>
      act(
        (current) =>
          triggerChaos(
            current,
            merchantId,
            "supplier_offline",
            `offline:${current.orderId}:${current.activePlan?.planId}:${merchantId}`,
          ),
        "recovery",
      ),
  };
}
