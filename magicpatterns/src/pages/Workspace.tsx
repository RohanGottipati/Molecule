import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowUp, Check, Mic, Paperclip } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Panel, PanelHeader } from '../components/ui/Panel';
import { Textarea } from '../components/ui/Field';
import { Tooltip } from '../components/ui/Tooltip';
import { conversation, hardConstraints } from '../data/workspace';
import { planSummary } from '../data/plan';
import { money } from '../components/canvas/nodeMeta';
import type { Turn } from '../types/molecule';
import { cn } from '../utils/cn';

export function Workspace() {
  const navigate = useNavigate();
  const [turns, setTurns] = useState<Turn[]>(conversation);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const send = () => {
    if (!draft.trim()) return;
    const text = draft.trim();
    setDraft('');
    setSending(true);
    setTurns((t) => [
    ...t,
    { id: `u${t.length}`, role: 'user', text, at: 'now' }]
    );
    window.setTimeout(() => {
      setTurns((t) => [
      ...t,
      {
        id: `m${t.length}`,
        role: 'molecule',
        text: 'Noted. Re-solving with that constraint — the plan stays VALID and the total moves by less than 1%.',
        at: 'now'
      }]
      );
      setSending(false);
    }, 1100);
  };

  return (
    <div className="grid h-full grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_296px]">
      {/* conversation */}
      <div className="mol-scroll flex h-full flex-col overflow-hidden">
        <div className="mol-scroll flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-[720px] space-y-3">
            {turns.map((turn, i) =>
            <motion.article
              key={turn.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: Math.min(i * 0.03, 0.2) }}
              className={cn(
                'mol-raise rounded-xl border px-3.5 py-3',
                turn.role === 'user' ?
                'border-border bg-s-2' :
                'border-border bg-s-1'
              )}>
              
                <header className="mb-1.5 flex items-center gap-2">
                  <span className="font-mono text-2xs uppercase tracking-[0.12em] text-faint">
                    {turn.role === 'user' ? 'You' : 'Molecule'}
                  </span>
                  {turn.voice && <Badge tone="cyan">voice</Badge>}
                  <span className="ml-auto font-mono text-2xs text-faint">{turn.at}</span>
                </header>
                <p className="text-md leading-relaxed text-foreground">{turn.text}</p>
                {turn.question &&
              <p className="mt-2 rounded-md border border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--warning)_9%,transparent)] px-2.5 py-2 text-base text-warning">
                    {turn.question}
                  </p>
              }
                {turn.attachments &&
              <div className="mt-2 flex flex-wrap gap-1.5">
                    {turn.attachments.map((a) =>
                <span
                  key={a}
                  className="rounded-xs border border-border bg-s-3 px-1.5 py-[2px] font-mono text-2xs text-muted-foreground">
                  
                        {a}
                      </span>
                )}
                  </div>
              }
              </motion.article>
            )}

            {sending &&
            <div className="flex items-center gap-2 px-1 py-1 text-base text-muted-foreground">
                <span className="flex gap-1" aria-hidden>
                  {[0, 1, 2].map((i) =>
                <motion.span
                  key={i}
                  className="size-1.5 rounded-full bg-primary"
                  animate={{ opacity: [0.25, 1, 0.25] }}
                  transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.16 }} />

                )}
                </span>
                Molecule is re-solving…
              </div>
            }
          </div>
        </div>

        {/* composer */}
        <div className="border-t border-border bg-background px-6 py-3">
          <div className="mx-auto w-full max-w-[720px]">
            <div className="rounded-xl border border-input bg-s-1 p-2 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] transition-colors duration-200 focus-within:border-[color-mix(in_srgb,var(--primary)_55%,transparent)]">
              <Textarea
                aria-label="Message Molecule"
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Add a constraint, ask about a supplier, or change the brief…"
                className="border-0 bg-transparent p-1 text-md shadow-none focus:shadow-none" />
              
              <div className="flex items-center gap-1 pt-1">
                <Tooltip label="Attach context">
                  <IconButton label="Attach context" size="xs">
                    <Paperclip className="size-3.5" />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Dictate">
                  <IconButton label="Dictate" size="xs">
                    <Mic className="size-3.5" />
                  </IconButton>
                </Tooltip>
                <span className="ml-auto font-mono text-2xs text-faint">
                  ↵ send · ⇧↵ newline
                </span>
                <IconButton
                  label="Send"
                  size="xs"
                  variant="primary"
                  disabled={!draft.trim()}
                  onClick={send}>
                  
                  <ArrowUp className="size-3.5" />
                </IconButton>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* context rail */}
      <aside className="mol-scroll hidden h-full overflow-y-auto border-l border-border bg-background p-3 lg:block">
        <Panel className="overflow-hidden">
          <PanelHeader
            kicker={planSummary.planId}
            title="Current plan"
            actions={<Badge tone="success" dot>{planSummary.status}</Badge>} />
          
          <dl className="grid grid-cols-2 gap-px bg-[var(--border)]">
            <Cell label="Total" value={money(planSummary.totalCost)} />
            <Cell label="Per unit" value={money(planSummary.unitCost)} />
            <Cell label="Units" value={planSummary.units.toLocaleString()} />
            <Cell label="Window" value={planSummary.span} />
          </dl>
          <div className="p-3">
            <Button
              variant="primary"
              size="md"
              className="w-full"
              icon={<Check className="size-3.5" />}
              onClick={() => navigate('/plan')}>
              
              Review &amp; approve
            </Button>
          </div>
        </Panel>

        <Panel className="mt-3 overflow-hidden">
          <PanelHeader kicker="Locked" title="Hard constraints" />
          <ul className="p-2.5">
            {hardConstraints.map((c) =>
            <li
              key={c}
              className="flex items-start gap-2 rounded-md px-1.5 py-1.5 text-base text-muted-foreground">
              
                <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
                {c}
              </li>
            )}
          </ul>
        </Panel>
      </aside>
    </div>);

}

function Cell({ label, value }: {label: string;value: string;}) {
  return (
    <div className="bg-s-1 px-3 py-2.5">
      <dt className="font-mono text-2xs uppercase tracking-[0.1em] text-faint">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-base text-foreground">{value}</dd>
    </div>);

}