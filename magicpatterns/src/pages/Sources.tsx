import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { FileSearch } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Panel, PanelHeader } from '../components/ui/Panel';
import { Segmented } from '../components/ui/Dropdown';
import { EmptyState, LoadingRows } from '../components/ui/States';
import { sourceClaims } from '../data/workspace';

type Filter = 'all' | 'verified' | 'conflict' | 'gap';

const tone = {
  verified: 'success',
  conflict: 'warning',
  gap: 'danger'
} as const;

export function Sources() {
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(false);

  const list = sourceClaims.filter((c) => filter === 'all' || c.state === filter);

  const refresh = (f: Filter) => {
    setFilter(f);
    setLoading(true);
    window.setTimeout(() => setLoading(false), 500);
  };

  return (
    <div className="mol-scroll h-full overflow-y-auto p-4">
      <div className="mx-auto w-full max-w-[880px]">
        <Panel className="overflow-hidden">
          <PanelHeader
            kicker="Evidence"
            title="Sources & claims"
            actions={
            <Segmented<Filter>
              value={filter}
              onChange={refresh}
              options={[
              { value: 'all', label: 'All' },
              { value: 'verified', label: 'Verified' },
              { value: 'conflict', label: 'Conflicts' },
              { value: 'gap', label: 'Gaps' }]
              } />

            } />
          

          {loading ?
          <LoadingRows rows={3} /> :
          list.length === 0 ?
          <EmptyState
            icon={<FileSearch className="size-5" />}
            title="Nothing to review"
            description="No claims of this kind were captured for the active project." /> :


          <ul className="divide-y divide-[var(--border)]">
              {list.map((c, i) =>
            <motion.li
              key={c.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04, duration: 0.28 }}
              className="px-4 py-3">
              
                  <div className="flex items-center gap-2">
                    <span className="text-base font-medium text-foreground">
                      {c.claim}
                    </span>
                    <Badge tone={tone[c.state]} dot>
                      {c.state}
                    </Badge>
                    <span className="ml-auto font-mono text-2xs text-faint">
                      {c.capturedAt}
                    </span>
                  </div>
                  <p className="mt-1 text-base text-muted-foreground">
                    <span className="text-foreground">{c.merchant}</span> · {c.evidence}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1 w-40 overflow-hidden rounded-full bg-s-3">
                      <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${c.confidence * 100}%` }}
                    transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                    className="h-full rounded-full"
                    style={{
                      background:
                      c.confidence > 0.7 ?
                      'var(--success)' :
                      c.confidence > 0.4 ?
                      'var(--warning)' :
                      'var(--destructive)'
                    }} />
                  
                    </div>
                    <span className="font-mono text-2xs text-faint">
                      {(c.confidence * 100).toFixed(0)}% confidence
                    </span>
                  </div>
                </motion.li>
            )}
            </ul>
          }
        </Panel>
      </div>
    </div>);

}