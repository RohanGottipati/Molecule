"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MerchantTwinSummary } from "@molecule/contracts";
import {
  buildKnowledgeNetwork,
  type KnowledgeSelection,
  type Point,
} from "../lib/knowledgeNetwork";
export type { KnowledgeSelection } from "../lib/knowledgeNetwork";

export function KnowledgeAtlas({
  merchants,
  filter,
  onSelect,
}: {
  merchants: MerchantTwinSummary[];
  filter: string;
  onSelect: (node: KnowledgeSelection) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x: 0, y: 0, zoom: 1 });
  const controls = useRef<(action: string) => void>(() => {});
  const [hover, setHover] = useState("");
  const graph = useMemo(
    () => buildKnowledgeNetwork(merchants, filter),
    [merchants, filter],
  );
  const callback = useRef(onSelect);
  callback.current = onSelect;

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    let width = 0,
      height = 0,
      frame = 0,
      selected: Point | null = null;
    let motionTime = 0;
    let drag: {
      x: number;
      y: number;
      startX: number;
      startY: number;
      moved: boolean;
    } | null = null;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const fine = matchMedia("(hover: hover) and (pointer: fine)");
    const clusterPhases = new Map<string, number>();
    for (const node of graph.nodes) {
      const cluster = node.merchantId ?? node.id;
      if (!clusterPhases.has(cluster)) {
        let hash = 0;
        for (const char of cluster) hash = (hash * 31 + char.charCodeAt(0)) | 0;
        clusterPhases.set(cluster, (Math.abs(hash) % 628) / 100);
      }
    }
    function fit() {
      const xs = graph.nodes.map((n) => n.x),
        ys = graph.nodes.map((n) => n.y);
      const minX = Math.min(0, ...xs),
        maxX = Math.max(1, ...xs),
        minY = Math.min(0, ...ys),
        maxY = Math.max(1, ...ys);
      const topInset = width < 600 ? 85 : 40;
      const availableHeight = Math.max(100, height - topInset - 45);
      const zoom = Math.min(
        1.5,
        Math.min(
          width / (maxX - minX + 180),
          availableHeight / (maxY - minY + 180),
        ) * 0.9,
      );
      view.current = {
        zoom,
        x: width / 2 - ((minX + maxX) / 2) * zoom,
        y: topInset + availableHeight / 2 - ((minY + maxY) / 2) * zoom,
      };
    }
    function resize() {
      const rect = element!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(devicePixelRatio, 2);
      element!.width = width * dpr;
      element!.height = height * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      fit();
      run();
    }
    function screen(n: Point) {
      // A shared, slow wave keeps the network coherent and edges attached.
      const phase = reduce.matches ? 0 : motionTime / 9000;
      const breathe = reduce.matches ? 1 : 1 + Math.sin(phase) * 0.012;
      const driftX = reduce.matches ? 0 : Math.sin(phase * 1.3) * 9;
      const driftY = reduce.matches ? 0 : Math.sin(phase * 0.9) * 6;
      const clusterPhase = clusterPhases.get(n.merchantId ?? n.id) ?? 0;
      const localX = reduce.matches
        ? 0
        : Math.sin(motionTime / 2800 + clusterPhase) * 11;
      const localY = reduce.matches
        ? 0
        : Math.cos(motionTime / 3400 + clusterPhase) * 9;
      return {
        x: n.x * breathe * view.current.zoom + view.current.x + driftX + localX,
        y: n.y * breathe * view.current.zoom + view.current.y + driftY + localY,
      };
    }
    function draw(time: number) {
      motionTime = time;
      ctx!.clearRect(0, 0, width, height);
      const zoom = view.current.zoom;
      const positions = graph.nodes.map(screen);
      const connected = new Set<number>();
      const index = selected ? graph.nodes.indexOf(selected) : -1;
      if (index >= 0)
        for (const [a, b] of graph.links) {
          if (a === index) connected.add(b);
          if (b === index) connected.add(a);
        }
      ctx!.lineWidth = 0.65;
      for (const [a, b] of graph.links) {
        const p = positions[a]!,
          q = positions[b]!;
        const active = a === index || b === index;
        const supplierLink =
          graph.nodes[a]!.kind === "Supplier" ||
          graph.nodes[b]!.kind === "Supplier";
        ctx!.lineWidth = supplierLink ? 1.2 : 0.65;
        ctx!.strokeStyle = active
          ? "#67a88e"
          : selected
            ? "#a8b9ca20"
            : supplierLink
              ? "#67a88eaa"
              : "#a8b9ca55";
        ctx!.beginPath();
        ctx!.moveTo(p.x, p.y);
        ctx!.lineTo(q.x, q.y);
        ctx!.stroke();
        if (!reduce.matches) {
          // Cosine eases each pulse into a reversal at both endpoints.
          const t = (1 - Math.cos(time / 1800 + a * 0.17)) / 2;
          const tail = Math.max(0, t - 0.055);
          ctx!.strokeStyle = active
            ? "#38a87e"
            : selected
              ? "#69aab82b"
              : supplierLink
                ? "#38a87ecc"
                : "#69aab89c";
          ctx!.lineWidth = active ? 2 : 1.3;
          ctx!.beginPath();
          ctx!.moveTo(p.x + (q.x - p.x) * tail, p.y + (q.y - p.y) * tail);
          ctx!.lineTo(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t);
          ctx!.stroke();
          ctx!.lineWidth = 0.65;
          ctx!.fillStyle = active
            ? "#3aa57b"
            : selected
              ? "#69aab82b"
              : supplierLink
                ? "#38a87e"
                : "#69aab8b0";
          ctx!.beginPath();
          ctx!.arc(
            p.x + (q.x - p.x) * t,
            p.y + (q.y - p.y) * t,
            active || supplierLink ? 2.2 : 1.25,
            0,
            Math.PI * 2,
          );
          ctx!.fill();
        }
      }
      graph.nodes.forEach((n, i) => {
        const p = positions[i]!;
        if (p.x < -100 || p.y < -50 || p.x > width + 100 || p.y > height + 50)
          return;
        const active = n === selected || connected.has(i);
        const radius =
          n.kind === "Supplier"
            ? Math.max(4, 12 * zoom)
            : n.kind === "Source"
              ? Math.max(2.2, 7 * zoom)
              : Math.max(1.7, 5 * zoom);
        ctx!.globalAlpha = selected && !active ? 0.25 : 1;
        ctx!.fillStyle = n.warning
          ? "#d99457"
          : n.kind === "Supplier"
            ? "#459b82"
            : n.kind === "Source"
              ? "#689be3"
              : n.kind === "Capability"
                ? "#59b5c8"
                : "#a184d6";
        if (n === selected) {
          ctx!.shadowColor = ctx!.fillStyle;
          ctx!.shadowBlur = 14;
        }
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.shadowBlur = 0;
        if (
          active ||
          (n.kind === "Supplier" && (zoom > 0.22 || n.claims.length > 0)) ||
          zoom > 1.1
        ) {
          ctx!.font = `${n.kind === "Supplier" ? "500" : "400"} 11px -apple-system, BlinkMacSystemFont, sans-serif`;
          ctx!.textAlign = "center";
          ctx!.fillStyle = "#354457";
          ctx!.fillText(
            n.title.length > 32 ? n.title.slice(0, 30) + "…" : n.title,
            p.x,
            p.y + radius + 15,
          );
        }
        ctx!.globalAlpha = 1;
      });
    }
    function animate(t: number) {
      draw(t);
      frame = requestAnimationFrame(animate);
    }
    function run() {
      cancelAnimationFrame(frame);
      frame = 0;
      draw(performance.now());
      if (graph.nodes.length && !reduce.matches && !document.hidden)
        frame = requestAnimationFrame(animate);
    }
    function locate(e: PointerEvent) {
      const rect = element!.getBoundingClientRect();
      const x = e.clientX - rect.left,
        y = e.clientY - rect.top;
      let nearest: Point | null = null,
        distance = 14;
      for (const n of graph.nodes) {
        const p = screen(n);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < distance) {
          nearest = n;
          distance = d;
        }
      }
      return nearest;
    }
    function move(e: PointerEvent) {
      if (drag) {
        const dx = e.clientX - drag.x,
          dy = e.clientY - drag.y;
        view.current.x += dx;
        view.current.y += dy;
        drag.x = e.clientX;
        drag.y = e.clientY;
        drag.moved ||=
          Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4;
        run();
        return;
      }
      if (!fine.matches) return;
      const n = locate(e);
      if (n !== selected) {
        selected = n;
        setHover(n ? `${n.kind} · ${n.title}` : "");
        element!.style.cursor = n ? "pointer" : "grab";
        run();
      }
    }
    function down(e: PointerEvent) {
      element!.setPointerCapture(e.pointerId);
      drag = {
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };
    }
    function up(e: PointerEvent) {
      if (drag && !drag.moved) {
        const n = locate(e);
        if (n) callback.current(n);
      }
      drag = null;
    }
    function wheel(e: WheelEvent) {
      e.preventDefault();
      const rect = element!.getBoundingClientRect();
      const x = e.clientX - rect.left,
        y = e.clientY - rect.top;
      const old = view.current.zoom,
        next = Math.max(0.025, Math.min(3, old * Math.exp(-e.deltaY * 0.002)));
      view.current = {
        zoom: next,
        x: x - ((x - view.current.x) * next) / old,
        y: y - ((y - view.current.y) * next) / old,
      };
      run();
    }
    function leave() {
      if (!drag) {
        selected = null;
        setHover("");
        run();
      }
    }
    function stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    controls.current = (action) => {
      if (action === "fit") fit();
      else {
        const old = view.current.zoom,
          next = Math.max(
            0.025,
            Math.min(3, old * (action === "in" ? 1.4 : 1 / 1.4)),
          );
        view.current = {
          zoom: next,
          x: width / 2 - ((width / 2 - view.current.x) * next) / old,
          y: height / 2 - ((height / 2 - view.current.y) * next) / old,
        };
      }
      run();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("visibilitychange", run);
    reduce.addEventListener("change", run);
    return () => {
      stop();
      observer.disconnect();
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", run);
      reduce.removeEventListener("change", run);
    };
  }, [graph]);
  return (
    <div className="knowledge-atlas">
      <div className="atlas-counts">
        <strong>{graph.nodes.length.toLocaleString()} nodes</strong>
        <span>{graph.suppliers} suppliers</span>
        <span>{graph.capabilities} capabilities</span>
        <span>{graph.facts.toLocaleString()} facts</span>
        <span>{graph.sources.toLocaleString()} sources</span>
        <span>{graph.links.length.toLocaleString()} connections</span>
      </div>
      <canvas
        ref={canvas}
        aria-label="Knowledge network. Use supplier search and the supplier selector to explore accessible evidence cards."
      />
      <div className="atlas-controls">
        <button
          onClick={() => controls.current("in")}
          aria-label="Zoom in on network"
        >
          +
        </button>
        <button
          onClick={() => controls.current("out")}
          aria-label="Zoom out of network"
        >
          −
        </button>
        <button onClick={() => controls.current("fit")}>Fit network</button>
      </div>
      <div className="atlas-hint">
        {hover || "Scroll to zoom · Drag to explore · Select a node"}
      </div>
    </div>
  );
}
