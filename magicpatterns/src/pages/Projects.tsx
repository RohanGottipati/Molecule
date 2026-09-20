import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, FolderSearch, Search, Sparkles } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Panel, PanelHeader } from '../components/ui/Panel';
import { Textarea } from '../components/ui/Field';
import { EmptyState, LoadingRows } from '../components/ui/States';
import { Segmented } from '../components/ui/Dropdown';
import { projects } from '../data/workspace';
import { money } from '../components/canvas/nodeMeta';
import type { Project } from '../types/molecule';

const stateTone: Record<
  Project['state'],
  {tone: 'neutral' | 'primary' | 'success' | 'warning' | 'violet';label: string;}> =
{
  draft: { tone: 'neutral', label: 'Draft' },
  planning: { tone: 'violet', label: 'Planning' },
  'awaiting-approval': { tone: 'warning', label: 'Needs approval' },
  executing: { tone: 'primary', label: 'Executing' },
  complete: { tone: 'success', label: 'Complete' }
};

type Filter = 'all' | 'active' | 'complete';

export function Projects() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [brief, setBrief] = useState('');
  const [loading, setLoading] = useState(false);

  const list = useMemo(() => {
    return projects.filter((p) => {
      const matches =
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.brief.toLowerCase().includes(query.toLowerCase());
      const inFilter =
      filter === 'all' || (
      filter === 'complete' ? p.state === 'complete' : p.state !== 'complete');
      return matches && inFilter;
    });
  }, [query, filter]);

  const submit = () => {
    if (!brief.trim()) return;
    setLoading(true);
    window.setTimeout(() => {
      setLoading(false);
      navigate('/workspace');
    }, 900);
  };

  return (
    <div className="mol-scroll h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1080px] px-6 py-7">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
          
          <div className="text-2xs font-mono uppercase tracking-[0.14em] text-faint">
            Command Center
          </div>
          <h1 className="mt-1.5 text-3xl font-medium tracking-tight">
            From idea to made.
          </h1>
          <p className="mt-1.5 max-w-lg text-md text-muted-foreground">
            Describe what you want to produce. Molecule finds suppliers, validates
            evidence, and returns a plan you can approve.
          </p>
        </motion.div>

        {/* brief composer */}
        <Panel className="mt-5 overflow-hidden">
          <div className="p-3">
            <Textarea
              aria-label="Project brief"
              rows={3}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="e.g. 2,400 heavyweight organic tees, made in the EU, landed before April 10…"
              className="border-0 bg-transparent text-md shadow-none focus:shadow-none" />
            
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border bg-s-2/50 px-3 py-2.5">
            <div className="flex flex-wrap gap-1.5">
              {['2,400 units', 'EU only', 'Before Apr 10'].map((chip) =>
              <span
                key={chip}
                className="rounded-xs border border-border bg-s-3 px-1.5 py-[2px] font-mono text-2xs text-muted-foreground">
                
                  {chip}
                </span>
              )}
            </div>
            <Button
              variant="primary"
              size="md"
              loading={loading}
              disabled={!brief.trim()}
              onClick={submit}
              icon={<Sparkles className="size-3.5" />}>
              
              Solve plan
            </Button>
          </div>
        </Panel>

        {/* saved projects */}
        <Panel className="mt-6 overflow-hidden">
          <PanelHeader
            kicker="Saved"
            title="Projects"
            actions={
            <>
                <Segmented<Filter>
                value={filter}
                onChange={setFilter}
                options={[
                { value: 'all', label: 'All' },
                { value: 'active', label: 'Active' },
                { value: 'complete', label: 'Complete' }]
                } />
              
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
                  <input
                  aria-label="Search projects"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter…"
                  className="h-7 w-[150px] rounded-md border border-border bg-s-1 pl-8 pr-2.5 text-sm placeholder:text-faint focus:border-[color-mix(in_srgb,var(--primary)_55%,transparent)] focus:outline-none" />
                
                </div>
              </>
            } />
          

          {loading ?
          <LoadingRows rows={3} /> :
          list.length === 0 ?
          <EmptyState
            icon={<FolderSearch className="size-5" />}
            title="No projects match"
            description="Try a different search term, or start a new brief above."
            action={
            <Button variant="secondary" onClick={() => setQuery('')}>
                  Clear filter
                </Button>
            } /> :


          <ul className="divide-y divide-[var(--border)]">
              {list.map((p, i) => {
              const st = stateTone[p.state];
              return (
                <motion.li
                  key={p.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.3 }}>
                  
                    <button
                    type="button"
                    onClick={() => navigate('/workspace')}
                    className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-200 hover:bg-s-2">
                    
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-md font-medium text-foreground">
                            {p.name}
                          </span>
                          <Badge tone={st.tone} dot={p.state !== 'draft'}>
                            {st.label}
                          </Badge>
                        </div>
                        <p className="mt-0.5 truncate text-base text-muted-foreground">
                          {p.brief}
                        </p>
                      </div>
                      <dl className="hidden shrink-0 items-center gap-5 font-mono text-2xs text-faint sm:flex">
                        <Stat label="Units" value={p.units.toLocaleString()} />
                        <Stat label="Nodes" value={String(p.nodeCount)} />
                        <Stat label="Total" value={p.totalCost ? money(p.totalCost) : '—'} />
                        <Stat label="Updated" value={p.updatedAt} />
                      </dl>
                      <ArrowRight className="size-4 shrink-0 text-faint transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-foreground" />
                    </button>
                  </motion.li>);

            })}
            </ul>
          }
        </Panel>
      </div>
    </div>);

}

function Stat({ label, value }: {label: string;value: string;}) {
  return (
    <div className="text-right">
      <dt className="uppercase tracking-[0.1em] text-faint">{label}</dt>
      <dd className="mt-0.5 text-sm text-muted-foreground">{value}</dd>
    </div>);

}