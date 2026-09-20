import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Building2, ExternalLink, MapPin } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Panel, PanelHeader } from '../components/ui/Panel';
import { Dropdown } from '../components/ui/Dropdown';
import { EmptyState } from '../components/ui/States';
import { suppliers } from '../data/workspace';
import { cn } from '../utils/cn';

const statusTone = {
  connected: 'success',
  quoting: 'primary',
  offline: 'danger'
} as const;

export function Suppliers() {
  const [region, setRegion] = useState('all');
  const [selected, setSelected] = useState(suppliers[0].id);

  const regions = [
  { value: 'all', label: 'All regions' },
  ...Array.from(new Set(suppliers.map((s) => s.region))).map((r) => ({
    value: r,
    label: r
  }))];

  const list = suppliers.filter((s) => region === 'all' || s.region === region);
  const detail = suppliers.find((s) => s.id === selected);

  return (
    <div className="grid h-full grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="mol-scroll h-full overflow-y-auto p-4">
        <Panel className="overflow-hidden">
          <PanelHeader
            kicker="Directory"
            title="Suppliers"
            actions={
            <Dropdown
              items={regions}
              value={region}
              onChange={setRegion}
              align="right"
              className="w-[150px]" />

            } />
          
          {list.length === 0 ?
          <EmptyState
            icon={<Building2 className="size-5" />}
            title="No suppliers in this region"
            description="Widen the region filter to see connected suppliers." /> :


          <ul className="grid grid-cols-1 gap-px bg-[var(--border)] sm:grid-cols-2">
              {list.map((s, i) =>
            <motion.li
              key={s.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03, duration: 0.28 }}
              className="bg-s-1">
              
                  <button
                type="button"
                onClick={() => setSelected(s.id)}
                className={cn(
                  'group h-full w-full px-3.5 py-3 text-left transition-colors duration-200 hover:bg-s-2',
                  selected === s.id && 'bg-s-2'
                )}>
                
                    <div className="flex items-center gap-2">
                      <span className="truncate text-base font-medium">{s.name}</span>
                      <Badge tone={statusTone[s.status]} dot>
                        {s.status}
                      </Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                      <MapPin className="size-3" />
                      {s.region}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {s.capabilities.map((c) =>
                  <span
                    key={c}
                    className="rounded-xs border border-border bg-s-3 px-1.5 py-[1px] text-2xs text-muted-foreground">
                    
                          {c}
                        </span>
                  )}
                    </div>
                    <div className="mt-2.5 flex items-center gap-4 font-mono text-2xs text-faint">
                      <span>{s.leadTimeDays}d lead</span>
                      <span>{(s.reliability * 100).toFixed(0)}% reliable</span>
                      <span>MOQ {s.minOrder}</span>
                    </div>
                  </button>
                </motion.li>
            )}
            </ul>
          }
        </Panel>
      </div>

      <aside className="mol-scroll hidden h-full overflow-y-auto border-l border-border bg-background p-3 lg:block">
        {detail &&
        <Panel className="overflow-hidden">
            <PanelHeader
            kicker={detail.region}
            title={detail.name}
            actions={<Badge tone={statusTone[detail.status]} dot>{detail.status}</Badge>} />
          
            <dl className="grid grid-cols-2 gap-px bg-[var(--border)]">
              <Cell label="Lead time" value={`${detail.leadTimeDays} days`} />
              <Cell label="Reliability" value={`${(detail.reliability * 100).toFixed(0)}%`} />
              <Cell label="Min order" value={detail.minOrder.toLocaleString()} />
              <Cell label="Capabilities" value={String(detail.capabilities.length)} />
            </dl>
            <div className="space-y-2 p-3">
              <div className="rounded-md border border-border bg-s-2 p-2.5">
                <div className="text-2xs font-mono uppercase tracking-[0.12em] text-faint">
                  Current quote
                </div>
                <p className="mt-1 text-base text-foreground">
                  {detail.status === 'offline' ?
                'No response in the last 6 hours. A replacement is staged.' :
                'Quoted against the active plan window with confirmed capacity.'}
                </p>
              </div>
              <Button
              variant="secondary"
              size="md"
              className="w-full"
              icon={<ExternalLink className="size-3.5" />}>
              
                Open supplier record
              </Button>
            </div>
          </Panel>
        }
      </aside>
    </div>);

}

function Cell({ label, value }: {label: string;value: string;}) {
  return (
    <div className="bg-s-1 px-3 py-2.5">
      <dt className="font-mono text-2xs uppercase tracking-[0.1em] text-faint">{label}</dt>
      <dd className="mt-0.5 text-base text-foreground">{value}</dd>
    </div>);

}