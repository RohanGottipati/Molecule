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
import {
  mergeContexts,
  mergeEvents,
  mergeSnapshot,
  parseEvent,
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
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(initialOrderId));
  const [error, setError] = useState<string | null>(null);
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
      if (id === activeId.current) setError(null);
    } catch (cause) {
      if (id === activeId.current) setError(message(cause));
    }
  }, [apply]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshMarketplace(controller.signal);
    void getDemoMode(controller.signal)
      .then((enabled) => {
        if (!controller.signal.aborted) {
          setDemoMode(enabled);
          setConfigError(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setConfigError(
            "Demo configuration unavailable. Recovery controls are disabled.",
          );
      });
    return () => controller.abort();
  }, [refreshMarketplace]);

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
        if (!controller.signal.aborted) setError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const source = new EventSource(
      `/api/orders/${encodeURIComponent(id)}/events`,
    );
    const seen = new Set<string>();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let marketplaceTimer: ReturnType<typeof setTimeout> | undefined;
    let streamConnected = false;
    const queueRefresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void getOrder(id, controller.signal)
          .then(apply)
          .catch((cause) => {
            if (!controller.signal.aborted) setError(message(cause));
          });
      }, 150);
    };
    source.addEventListener("ready", () => {
      if (controller.signal.aborted) return;
      streamConnected = true;
      setConnection("connected");
      queueRefresh();
    });
    source.addEventListener("molecule", (event: MessageEvent<string>) => {
      if (controller.signal.aborted) return;
      const validated = parseEvent(event.data, id);
      if (!validated) {
        streamConnected = false;
        setConnection("invalid");
        queueRefresh();
        return;
      }
      if (seen.has(validated.eventId)) return;
      seen.add(validated.eventId);
      setEvents((current) => mergeEvents(current, [validated]));
      queueRefresh();
      clearTimeout(marketplaceTimer);
      marketplaceTimer = setTimeout(
        () => void refreshMarketplace(controller.signal),
        1_500,
      );
    });
    source.onerror = () => {
      if (!controller.signal.aborted) {
        streamConnected = false;
        setConnection("reconnecting");
      }
    };
    const poll = setInterval(() => {
      if (!streamConnected) queueRefresh();
    }, 10_000);
    return () => {
      controller.abort();
      source.close();
      clearInterval(poll);
      clearTimeout(refreshTimer);
      clearTimeout(marketplaceTimer);
    };
  }, [orderId, apply, refreshMarketplace]);

  async function send(text: string) {
    if (pending.current || !text.trim()) return false;
    pending.current = true;
    setBusy(true);
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
      const key = `message:${id}:${current.intentVersion}:${await digest(text.trim())}`;
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
      setBusy(false);
    }
  }

  async function act(
    action: (current: OrderSessionSnapshot) => Promise<OrderSessionSnapshot>,
  ) {
    if (pending.current || !orderRef.current) return;
    const current = orderRef.current;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      apply(await action(current));
      void refreshMarketplace();
    } catch (cause) {
      if (activeId.current === current.orderId) setError(message(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function upload(file: File) {
    if (pending.current || !orderRef.current) return;
    const current = orderRef.current;
    pending.current = true;
    setBusy(true);
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
      setBusy(false);
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
    busy,
    loading,
    error,
    connection,
    navigate,
    newProject,
    refresh,
    refreshMarketplace,
    send,
    upload,
    approve: () => act(approvePlan),
    offline: (merchantId: string) =>
      act((current) =>
        triggerChaos(
          current,
          merchantId,
          "supplier_offline",
          `offline:${current.orderId}:${current.activePlan?.planId}:${merchantId}`,
        ),
      ),
  };
}
