import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { PlanNode } from '../../types/molecule';
import { Badge } from '../ui/Badge';
import { NODE_H, NODE_W, kindMeta, money, statusMeta } from './nodeMeta';
import { cn } from '../../utils/cn';

export function PlanNodeCard({
  node,
  selected,
  onSelect




}: {node: PlanNode;selected: boolean;onSelect: (id: string) => void;}) {
  const kind = kindMeta[node.kind];
  const status = statusMeta[node.status];
  const isFailed = node.status === 'failed';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
      className="absolute z-10">
      
      <AnimatePresence>
        {selected &&
        <motion.span
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="mol-glow-ring" />

        }
      </AnimatePresence>

      {node.status === 'running' && !selected &&
      <motion.span
        aria-hidden
        className="pointer-events-none absolute -inset-2 rounded-3xl"
        style={{ background: 'var(--primary)', filter: 'blur(16px)' }}
        animate={{ opacity: [0.08, 0.26, 0.08] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }} />

      }

      <motion.button
        type="button"
        onClick={() => onSelect(node.nodeId)}
        aria-pressed={selected}
        whileHover={{ y: -2 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          'group relative flex h-full w-full items-center gap-2.5 rounded-2xl px-2.5 text-left',
          'border bg-[color-mix(in_srgb,var(--surface-2)_94%,transparent)]',
          'transition-[border-color,box-shadow] duration-300 ease-mol',
          selected ?
          'border-border-strong shadow-[0_18px_50px_-18px_rgba(0,0,0,0.9)]' :
          'border-border shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_10px_30px_-14px_rgba(0,0,0,0.9)] hover:border-border-strong',
          isFailed &&
          !selected &&
          'border-dashed border-[color-mix(in_srgb,var(--destructive)_45%,transparent)]'
        )}>
        
        {/* icon tile */}
        <span
          className="relative flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-s-3"
          style={{
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.07), 0 0 18px -8px ${kind.accent}`
          }}>
          
          <span style={{ color: kind.accent }}>{kind.icon}</span>
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-base font-medium text-foreground">
              {node.merchantName}
            </span>
            <Badge tone={status.tone} dot={node.status !== 'idle'} className="shrink-0">
              {status.label}
            </Badge>
          </span>
          <span className="mt-0.5 block truncate text-sm text-muted-foreground">
            {node.capabilityName}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-2xs text-faint">
            <span className="uppercase tracking-[0.08em]">{kind.label}</span>
            <span className="opacity-40">·</span>
            <span>{money(node.totalCost)}</span>
            <span className="opacity-40">·</span>
            <span>
              {node.quantity.toLocaleString()} {node.unit}
            </span>
          </span>
        </span>

        <Handle side="left" />
        <Handle
          side="right"
          active={node.status === 'running' || node.status === 'success'} />
        
      </motion.button>
    </motion.div>);

}

function Handle({ side, active }: {side: 'left' | 'right';active?: boolean;}) {
  return (
    <span
      aria-hidden
      className={cn(
        'absolute top-1/2 size-[7px] -translate-y-1/2 rounded-full border transition-all duration-300',
        side === 'left' ? '-left-[4px]' : '-right-[4px]',
        active ?
        'border-[color-mix(in_srgb,var(--primary)_70%,transparent)] bg-primary shadow-[0_0_10px_var(--primary)]' :
        'border-border-strong bg-s-3 group-hover:bg-muted-foreground'
      )} />);


}