import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { PackageSearch, Plus } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Panel } from '../components/ui/Panel';
import { Segmented } from '../components/ui/Dropdown';
import { EmptyState } from '../components/ui/States';
import { recipes } from '../data/workspace';

const readinessTone = {
  ready: 'success',
  partial: 'warning',
  blocked: 'danger'
} as const;

export function Recipes() {
  const categories = ['All', ...Array.from(new Set(recipes.map((r) => r.category)))];
  const [category, setCategory] = useState('All');

  const list = recipes.filter((r) => category === 'All' || r.category === category);

  return (
    <div className="mol-scroll h-full overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-[1040px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-2xs font-mono uppercase tracking-[0.14em] text-faint">
              Catalog
            </div>
            <h1 className="mt-1 text-2xl font-medium tracking-tight">Recipe gallery</h1>
            <p className="mt-1 max-w-md text-base text-muted-foreground">
              Pre-validated production graphs. Start from one and Molecule fills in
              live suppliers and quotes.
            </p>
          </div>
          <Segmented
            value={category}
            onChange={setCategory}
            options={categories.map((c) => ({ value: c, label: c }))} />
          
        </div>

        {list.length === 0 ?
        <EmptyState
          icon={<PackageSearch className="size-5" />}
          title="No recipes here yet"
          description="Pick another category, or start from a blank brief." /> :


        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((r, i) =>
          <motion.div
            key={r.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04, duration: 0.32, ease: [0.22, 1, 0.36, 1] }}>
            
                <Panel className="group flex h-full flex-col p-3.5 transition-all duration-200 ease-mol hover:-translate-y-0.5 hover:border-border-strong">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-md font-medium text-foreground">{r.name}</h2>
                    <Badge tone={readinessTone[r.readiness]} dot>
                      {r.readiness}
                    </Badge>
                  </div>
                  <p className="mt-1 flex-1 text-base text-muted-foreground">
                    {r.description}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {r.operations.map((op) =>
                <span
                  key={op}
                  className="rounded-xs border border-border bg-s-3 px-1.5 py-[1px] font-mono text-2xs text-muted-foreground">
                  
                        {op}
                      </span>
                )}
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5 font-mono text-2xs text-faint">
                    <span>{r.suppliers} suppliers</span>
                    <span>
                      {r.missingEvidence === 0 ?
                  'evidence complete' :
                  `${r.missingEvidence} gaps`}
                    </span>
                  </div>
                  <Button
                variant="secondary"
                size="md"
                className="mt-3 w-full opacity-90 transition-opacity group-hover:opacity-100"
                icon={<Plus className="size-3.5" />}>
                
                    Start from recipe
                  </Button>
                </Panel>
              </motion.div>
          )}
          </div>
        }
      </div>
    </div>);

}