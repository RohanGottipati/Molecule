"use client";

import type {
  AssetRef,
  MessageHistory,
  MoleculeEvent,
  OrderSessionSnapshot,
} from "@molecule/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { RequestError } from "./api";
import { subscribeEvents } from "./events";
import { readProject } from "./projectReadModel";
import {
  createReadQueue,
  type CapabilitiesRead,
  type Freshness,
} from "./synchronization";
import { mergeEvents } from "./workspace";

export type Connection =
  "idle" | "connecting" | "connected" | "reconnecting" | "invalid";

export function useProjectSync(
  orderId: string | null,
  apply: (snapshot: OrderSessionSnapshot) => boolean,
  reconcile: (signal?: AbortSignal) => Promise<void>,
  refreshGlobals: () => void,
) {
  const [events, setEvents] = useState<MoleculeEvent[]>([]);
  const [contexts, setContexts] = useState<AssetRef[]>([]);
  const [history, setHistory] = useState<MessageHistory>({
    messages: [],
    nextCursor: null,
  });
  const [capabilities, setCapabilities] = useState<CapabilitiesRead | null>(
    null,
  );
  const [freshness, setFreshness] = useState<Freshness>(
    orderId ? "loading" : "idle",
  );
  const [loading, setLoading] = useState(!!orderId);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("idle");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const queue = useRef<ReturnType<typeof createReadQueue> | null>(null);
  const pages = useRef(1);
  const freshnessRef = useRef(freshness);
  const invalidateRef = useRef(() => {});
  const updateFreshness = useCallback((value: Freshness) => {
    freshnessRef.current = value;
    setFreshness(value);
  }, []);
  useEffect(() => {
    setEvents([]);
    setContexts([]);
    setHistory({ messages: [], nextCursor: null });
    setCapabilities(null);
    setSyncError(null);
    setLastSyncedAt(null);
    setLoading(!!orderId);
    setHistoryLoading(false);
    pages.current = 1;
    updateFreshness(orderId ? "loading" : "idle");
    setConnection(orderId ? "connecting" : "idle");
    if (!orderId) return;
    const controller = new AbortController();
    let epoch = 0;
    let initialized = false;
    let missing = false;
    let globalTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    let poll: ReturnType<typeof setInterval> | undefined;
    const stopLiveUpdates = () => {
      missing = true;
      unsubscribe();
      unsubscribe = () => {};
      clearInterval(poll);
      poll = undefined;
      setConnection("idle");
    };
    const globals = () => {
      if (!globalTimer)
        globalTimer = setTimeout(() => {
          globalTimer = undefined;
          refreshGlobals();
        }, 1_500);
    };
    const reader = createReadQueue(
      async () => {
        if (missing) return;
        const started = epoch;
        updateFreshness(initialized ? "refreshing" : "loading");
        const attempt = new AbortController();
        const signal = AbortSignal.any([
          controller.signal,
          attempt.signal,
          AbortSignal.timeout(15_000),
        ]);
        try {
          const [read] = await Promise.all([
            readProject(orderId, pages.current, signal),
            reconcile(signal),
          ]);
          if (controller.signal.aborted) return;
          if (!apply(read.order)) return;
          setContexts(read.contexts);
          setCapabilities(read.capabilities);
          setHistory(read.history);
          setSyncError(null);
          setLoading(false);
          setHistoryLoading(false);
          setLastSyncedAt(Date.now());
          initialized = true;
          updateFreshness(started === epoch ? "fresh" : "refreshing");
        } finally {
          attempt.abort();
        }
      },
      (cause) => {
        setLoading(false);
        setHistoryLoading(false);
        updateFreshness("stale");
        setSyncError(
          cause instanceof Error ? cause.message : "Project refresh failed.",
        );
        if (
          !initialized &&
          cause instanceof RequestError &&
          cause.status === 404
        )
          stopLiveUpdates();
      },
    );
    queue.current = reader;
    const invalidate = () => {
      epoch++;
      updateFreshness(initialized ? "refreshing" : "loading");
      reader.request();
    };
    invalidateRef.current = invalidate;
    void reader.flush();
    unsubscribe = subscribeEvents(orderId, {
      onReady: () => {
        setConnection("connected");
        invalidate();
        globals();
      },
      onEvent: (event) => {
        setEvents((current) => mergeEvents(current, [event]));
        invalidate();
        globals();
      },
      onReconnect: () => {
        setConnection("reconnecting");
        updateFreshness("stale");
        reader.request();
      },
      onInvalid: () => {
        setConnection("invalid");
        updateFreshness("stale");
        reader.request();
      },
    });
    poll = setInterval(() => reader.request(), 10_000);
    const visible = () => {
      if (document.visibilityState === "visible") {
        invalidate();
        globals();
      }
    };
    window.addEventListener("online", invalidate);
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      reader.stop();
      unsubscribe();
      clearInterval(poll);
      clearTimeout(globalTimer);
      window.removeEventListener("online", invalidate);
      document.removeEventListener("visibilitychange", visible);
      if (queue.current === reader) queue.current = null;
      invalidateRef.current = () => {};
    };
  }, [orderId, apply, reconcile, refreshGlobals, updateFreshness]);
  const refresh = useCallback(async () => {
    invalidateRef.current();
    await queue.current?.flush();
  }, []);
  const loadMoreHistory = useCallback(() => {
    if (history.nextCursor === null || historyLoading) return;
    pages.current++;
    setHistoryLoading(true);
    invalidateRef.current();
  }, [history.nextCursor, historyLoading]);
  return {
    events,
    contexts,
    history,
    capabilities,
    freshness,
    freshnessRef,
    loading,
    historyLoading,
    syncError,
    connection,
    lastSyncedAt,
    refresh,
    loadMoreHistory,
    invalidate: () => invalidateRef.current(),
  };
}
