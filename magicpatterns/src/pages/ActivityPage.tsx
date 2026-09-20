import React from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, CircleDot, Info } from 'lucide-react';
import { Panel, PanelHeader } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { activityEvents } from '../data/workspace';

const levelMeta = {
  info: { icon: <Info className="size-3.5" />, color: 'var(--muted-foreground)' },
  success: { icon: <CheckCircle2 className="size-3.5" />, color: 'var(--success)' },
  warn: { icon: <AlertTriangle className="size-3.5" />, color: 'var(--warning)' },
  error: { icon: <CircleDot className="size-3.5" />, color: 'var(--destructive)' }
} as const;

export function ActivityPage() {
  return (
    <div className="mol-scroll h-full overflow-y-auto p-4">
      <div className="mx-auto w-full max-w-[760px]">
        <Panel className="overflow-hidden">
          <PanelHeader
            kicker="Project stream"
            title="Activity"
            actions={<Badge tone="primary" dot>Live</Badge>} />
          
          <ol className="p-4">
            {activityEvents.map((e, i) => {
              const meta = levelMeta[e.level];
              return (
                <motion.li
                  key={e.id}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.3 }}
                  className="relative flex gap-3 pb-4 last:pb-0">
                  
                  {i < activityEvents.length - 1 &&
                  <span className="absolute left-[13px] top-7 h-full w-px bg-border" />
                  }
                  <span
                    className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-s-2"
                    style={{ color: meta.color }}>
                    
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-medium text-foreground">
                        {e.label}
                      </span>
                      <span className="font-mono text-2xs text-faint">{e.type}</span>
                      <span className="ml-auto font-mono text-2xs text-faint">{e.at}</span>
                    </div>
                    <p className="mt-0.5 text-base text-muted-foreground">{e.detail}</p>
                  </div>
                </motion.li>);

            })}
          </ol>
        </Panel>
      </div>
    </div>);

}