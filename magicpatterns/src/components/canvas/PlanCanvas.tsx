import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import type { PlanEdge, PlanNode } from '../../types/molecule';
import { IconButton } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { PlanNodeCard } from './PlanNodeCard';
import { NODE_H, NODE_W } from './nodeMeta';
import { cn } from '../../utils/cn';

interface Props {
  nodes: PlanNode[];
  edges: PlanEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  animateEdges?: boolean;
  className?: string;
  overlay?: React.ReactNode;
}

export function PlanCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
  animateEdges = true,
  className,
  overlay
}: Props) {
  const [view, setView] = useState({ x: 40, y: 20, k: 1 });
  const drag = useRef<{x: number;y: number;vx: number;vy: number;} | null>(null);
  const [panning, setPanning] = useState(false);

  const byId = useMemo(
    () => Object.fromEntries(nodes.map((n) => [n.nodeId, n])),
    [nodes]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      setPanning(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [view.x, view.y]
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    const d = drag.current;
    setView((v) => ({
      ...v,
      x: d.vx + (e.clientX - d.x),
      y: d.vy + (e.clientY - d.y)
    }));
  }, []);

  const endPan = useCallback(() => {
    drag.current = null;
    setPanning(false);
  }, []);

  const zoom = (delta: number) =>
  setView((v) => ({ ...v, k: Math.min(1.6, Math.max(0.45, +(v.k + delta).toFixed(2))) }));

  const reset = () => setView({ x: 40, y: 20, k: 1 });

  return (
    <div
      className={cn(
        'mol-dots relative h-full w-full overflow-hidden',
        panning ? 'cursor-grabbing' : 'cursor-grab',
        className
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerLeave={endPan}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
      role="application"
      aria-label="Production plan canvas">
      
      {/* vignette */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[5]"
        style={{
          background:
          'radial-gradient(120% 90% at 50% 40%, transparent 40%, color-mix(in srgb, var(--canvas) 85%, transparent) 100%)'
        }} />
      

      <div
        className="absolute left-0 top-0 origin-top-left transition-transform duration-75"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          width={1800}
          height={760}
          aria-hidden>
          
          <defs>
            <linearGradient id="mol-edge" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0.35" />
              <stop offset="50%" stopColor="var(--primary)" stopOpacity="0.55" />
              <stop offset="100%" stopColor="var(--violet)" stopOpacity="0.35" />
            </linearGradient>
          </defs>
          {edges.map((edge) => {
            const from = byId[edge.fromNodeId];
            const to = byId[edge.toNodeId];
            if (!from || !to) return null;
            const sx = from.x + NODE_W;
            const sy = from.y + NODE_H / 2;
            const tx = to.x;
            const ty = to.y + NODE_H / 2;
            const dx = Math.max(70, (tx - sx) / 1.6);
            const d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
            const active =
            selectedId === edge.fromNodeId || selectedId === edge.toNodeId;
            const flowing =
            from.status === 'success' || from.status === 'running';
            const mx = (sx + tx) / 2;
            const my = (sy + ty) / 2;

            return (
              <g key={edge.edgeId}>
                <path
                  d={d}
                  fill="none"
                  stroke="url(#mol-edge)"
                  strokeWidth={active ? 5 : 3.5}
                  strokeOpacity={active ? 0.5 : 0.22}
                  style={{ filter: 'blur(5px)' }} />
                
                <path
                  d={d}
                  fill="none"
                  stroke="var(--border-strong)"
                  strokeWidth={1.25} />
                
                {flowing && animateEdges &&
                <path
                  d={d}
                  fill="none"
                  stroke="url(#mol-edge)"
                  strokeWidth={1.5}
                  strokeDasharray="4 8"
                  className="mol-edge-flow" />

                }
                <g transform={`translate(${mx}, ${my})`}>
                  <rect
                    x={-40}
                    y={-9}
                    width={80}
                    height={18}
                    rx={5}
                    fill="var(--surface-2)"
                    stroke="var(--border)"
                    opacity={active ? 1 : 0.85} />
                  
                  <text
                    textAnchor="middle"
                    dominantBaseline="middle"
                    y={1}
                    fontSize={9}
                    fontFamily="Geist Mono, monospace"
                    fill="var(--muted-foreground)">
                    
                    {edge.quantity} {edge.unit}
                  </text>
                </g>
              </g>);

          })}
        </svg>

        {nodes.map((node) =>
        <PlanNodeCard
          key={node.nodeId}
          node={node}
          selected={selectedId === node.nodeId}
          onSelect={onSelect} />

        )}
      </div>

      {/* controls */}
      <div className="absolute bottom-4 left-4 z-20 flex items-center gap-1 rounded-lg border border-border bg-[color-mix(in_srgb,var(--surface-2)_80%,transparent)] p-1 backdrop-blur-xl mol-raise">
        <Tooltip label="Zoom out">
          <IconButton label="Zoom out" size="xs" onClick={() => zoom(-0.1)}>
            <Minus className="size-3.5" />
          </IconButton>
        </Tooltip>
        <span className="w-10 text-center font-mono text-2xs text-muted-foreground">
          {Math.round(view.k * 100)}%
        </span>
        <Tooltip label="Zoom in">
          <IconButton label="Zoom in" size="xs" onClick={() => zoom(0.1)}>
            <Plus className="size-3.5" />
          </IconButton>
        </Tooltip>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <Tooltip label="Reset view">
          <IconButton label="Reset view" size="xs" onClick={reset}>
            <Maximize2 className="size-3.5" />
          </IconButton>
        </Tooltip>
      </div>

      <div className="pointer-events-none absolute bottom-4 right-4 z-20 flex items-center gap-3 rounded-lg border border-border bg-[color-mix(in_srgb,var(--surface-2)_80%,transparent)] px-2.5 py-1.5 font-mono text-2xs uppercase tracking-[0.1em] text-faint backdrop-blur-xl">
        <LegendDot color="var(--cyan)" label="Supply" />
        <LegendDot color="var(--primary)" label="Transform" />
        <LegendDot color="var(--violet)" label="Assemble" />
        <LegendDot color="var(--success)" label="Fulfill" />
      </div>

      {overlay}
    </div>);

}

function LegendDot({ color, label }: {color: string;label: string;}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="size-1.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      
      {label}
    </span>);

}