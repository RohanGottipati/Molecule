"use client";

import type { ProjectList } from "@molecule/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getProjects } from "./api";

export function useProjectDiscovery() {
  const [projects, setProjects] = useState<ProjectList["projects"]>([]);
  const [projectSearch, setSearch] = useState("");
  const [projectsLoading, setLoading] = useState(true);
  const [projectsError, setError] = useState<string | null>(null);
  const [projectsNextCursor, setCursor] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const search = useRef("");
  const cursor = useRef<string | null>(null);
  const load = useCallback(async (more = false) => {
    if (more && (request.current || !cursor.current)) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const page = await getProjects(
        {
          search: search.current,
          ...(more && cursor.current ? { cursor: cursor.current } : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setProjects((previous) =>
        more
          ? [
              ...new Map(
                [...previous, ...page.projects].map((item) => [
                  item.orderId,
                  item,
                ]),
              ).values(),
            ]
          : page.projects,
      );
      cursor.current = page.nextCursor;
      setCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Projects could not be loaded.",
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [projectSearch, load]);
  const setProjectSearch = useCallback((value: string) => {
    search.current = value.slice(0, 100);
    cursor.current = null;
    request.current?.abort();
    setCursor(null);
    setSearch(search.current);
  }, []);
  return {
    projects,
    projectSearch,
    setProjectSearch,
    projectsLoading,
    projectsError,
    projectsNextCursor,
    refreshProjects: load,
    loadMoreProjects: () => load(true),
  };
}
