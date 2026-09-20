import React, { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { CalendarRange, Check, List, Network, Play } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Segmented } from '../components/ui/Dropdown';
import { Modal } from '../components/ui/Modal';
import { PlanCanvas } from '../components/canvas/PlanCanvas';
import { NodeInspector } from '../components/canvas/NodeInspector';
import { kindMeta, money, statusMeta } from '../components/canvas/nodeMeta';
import { planEdges, planNodes, planSummary } from '../data/plan';
import type { PlanNode } from '../types/molecule';
import { cn } from '../utils/cn';

type View = 'network' | 'list' | 'timeline';

export function PlanActions({ animateEdges = true }: {animateEdges?: boolean;}) {
  const [nodes, setNodes] = useState<PlanNode[]>(planNodes);
  const [selected, setSelected] = useState<string | null>('nd_knit');
  const [view, setView] = useState<View>('network');
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const selectedNode = nodes.find((n) => n.nodeId === selected) ?? null;
  const total = nodes.reduce((sum, n) => sum + n.totalCost, 0);

  const save = (nodeId: string, patch: Partial<PlanNode>) => {
    setNodes((list) =>
    list.map((n) => n.nodeId === nodeId ? { ...n, ...patch } : n)
    );
  };

  const confirm = () => {
    setSubmitting(true);
    window.setTimeout(() => {
      setSubmitting(false);
      setApproving(false);
      setApproved(true);
      setNodes((list) =>
      list.map((n) => n.status === 'idle' ? { ...n, status: 'running' } : n)
      );
    }, 1200);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* plan toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-background px-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs uppercase tracking-[0.12em] text-faint">
            {planSummary.planId}
          </span>
          <Badge tone={approved ? 'primary' : 'success'} dot>
            {approved ? 'Executing' : planSummary.status}
          </Badge>
        </div>
        <div className="hidden items-center gap-4 font-mono text-2xs text-muted-foreground md:flex">
          <span>{nodes.length} nodes</span>
          <span className="text-faint">·</span>
          <span>{money(total)}</span>
          <span className="text-faint">·</span>
          <span>{planSummary.span}</span>
          <span className="text-faint">·</span>
          <span>confidence {(planSummary.confidence * 100).toFixed(0)}%</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
            { value: 'network', label: <><Network className="size-3.5" />Network</> },
            { value: 'list', label: <><List className="size-3.5" />List</> },
            { value: 'timeline', label: <><CalendarRange className="size-3.5" />Timeline</> }]
            } />
          
          <Button
            variant="primary"
            icon={approved ? <Check className="size-3.5" /> : <Play className="size-3.5" />}
            onClick={() => approved ? undefined : setApproving(true)}
            disabled={approved}>
            
            {approved ? 'Approved' : 'Approve & execute'}
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {view === 'network' &&
        <PlanCanvas
          nodes={nodes}
          edges={planEdges}
          selectedId={selected}
          onSelect={setSelected}
          animateEdges={animateEdges}
          overlay={
          <AnimatePresence mode="wait">
                {selectedNode &&
            <NodeInspector
              node={selectedNode}
              onClose={() => setSelected(null)}
              onSave={save} />

            }
              </AnimatePresence>
          } />

        }

        {view === 'list' &&
        <div className="mol-scroll h-full overflow-y-auto p-4">
            <ul className="mx-auto w-full max-w-[880px] space-y-2">
              {nodes.map((n) => {
              const meta = kindMeta[n.kind];
              const st = statusMeta[n.status];
              return (
                <li key={n.nodeId}>
                    <button
                    type="button"
                    onClick={() => {
                      setSelected(n.nodeId);
                      setView('network');
                    }}
                    className={cn(
                      'mol-raise flex w-full items-center gap-3 rounded-xl border border-border bg-s-1 px-3 py-2.5 text-left',
                      'transition-all duration-200 ease-mol hover:border-border-strong hover:bg-s-2'
                    )}>
                    
                      <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-s-3"
                      style={{ color: meta.accent }}>
                      
                        {meta.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-base font-medium">
                            {n.merchantName}
                          </span>
                          <Badge tone={st.tone} dot={n.status !== 'idle'}>
                            {st.label}
                          </Badge>
                        </span>
                        <span className="block truncate text-sm text-muted-foreground">
                          {n.capabilityName} · {n.region}
                        </span>
                      </span>
                      <span className="hidden font-mono text-sm text-muted-foreground sm:block">
                        {n.quantity.toLocaleString()} {n.unit}
                      </span>
                      <span className="font-mono text-sm text-foreground">
                        {money(n.totalCost)}
                      </span>
                    </button>
                  </li>);

            })}
            </ul>
          </div>
        }

        {view === 'timeline' &&
        <div className="mol-scroll h-full overflow-y-auto p-6">
            <ol className="mx-auto w-full max-w-[880px]">
              {nodes.map((n, i) => {
              const meta = kindMeta[n.kind];
              const st = statusMeta[n.status];
              return (
                <li key={n.nodeId} className="relative flex gap-4 pb-5 last:pb-0">
                    {i < nodes.length - 1 &&
                  <span className="absolute left-[15px] top-8 h-full w-px bg-border" />
                  }
                    <span
                    className="relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-s-2"
                    style={{ color: meta.accent }}>
                    
                      {meta.icon}
                    </span>
                    <div className="mol-raise flex-1 rounded-xl border border-border bg-s-1 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-medium">{n.merchantName}</span>
                        <Badge tone={st.tone} dot={n.status !== 'idle'}>
                          {st.label}
                        </Badge>
                        <span className="ml-auto font-mono text-2xs text-faint">
                          {n.startsAt} → {n.completesAt}
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {n.capabilityName} · {n.leadTimeDays}-day lead · {money(n.totalCost)}
                      </p>
                    </div>
                  </li>);

            })}
            </ol>
          </div>
        }
      </div>

      <Modal
        open={approving}
        onClose={() => setApproving(false)}
        kicker={planSummary.planId}
        title="Approve & execute plan"
        footer={
        <>
            <Button variant="ghost" size="md" onClick={() => setApproving(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="md" loading={submitting} onClick={confirm}>
              Approve {money(total)}
            </Button>
          </>
        }>
        
        <p className="text-md text-muted-foreground">
          Approving will place purchase orders with {nodes.length} suppliers and
          write commerce records. Each node becomes a tracked action with its own
          receipt.
        </p>
        <ul className="mt-3 space-y-1.5">
          {nodes.map((n) =>
          <li
            key={n.nodeId}
            className="flex items-center gap-2 rounded-md border border-border bg-s-2 px-2.5 py-2">
            
              <span className="truncate text-base">{n.merchantName}</span>
              <span className="ml-auto font-mono text-sm text-muted-foreground">
                {money(n.totalCost)}
              </span>
            </li>
          )}
        </ul>
      </Modal>
    </div>);

}