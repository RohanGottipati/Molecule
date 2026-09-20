import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import type { PlanNode } from '../../types/molecule';
import { Badge } from '../ui/Badge';
import { Button, IconButton } from '../ui/Button';
import { Input, Label, SectionLabel, Select } from '../ui/Field';
import { kindMeta, money, statusMeta } from './nodeMeta';
import { suppliers } from '../../data/workspace';

interface Props {
  node: PlanNode;
  onClose: () => void;
  onSave: (nodeId: string, patch: Partial<PlanNode>) => void;
}

export function NodeInspector({ node, onClose, onSave }: Props) {
  const [merchantName, setMerchantName] = useState(node.merchantName);
  const [quantity, setQuantity] = useState(String(node.quantity));
  const [unitCost, setUnitCost] = useState(String(node.unitCost));
  const [kind, setKind] = useState(node.kind);

  useEffect(() => {
    setMerchantName(node.merchantName);
    setQuantity(String(node.quantity));
    setUnitCost(String(node.unitCost));
    setKind(node.kind);
  }, [node]);

  const qty = Number(quantity) || 0;
  const cost = Number(unitCost) || 0;
  const total = qty * cost;
  const dirty =
  merchantName !== node.merchantName ||
  qty !== node.quantity ||
  cost !== node.unitCost ||
  kind !== node.kind;

  const meta = kindMeta[node.kind];
  const status = statusMeta[node.status];

  const output = JSON.stringify(
    {
      nodeId: node.nodeId,
      status: node.status,
      merchant: merchantName,
      totalCost: Number(total.toFixed(2)),
      window: [node.startsAt, node.completesAt],
      leadTimeDays: node.leadTimeDays
    },
    null,
    2
  );

  return (
    <motion.aside
      key={node.nodeId}
      initial={{ opacity: 0, x: -12, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -12, scale: 0.98 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      aria-label={`Configure ${node.merchantName}`}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute left-5 top-5 z-30 w-[290px] overflow-hidden rounded-2xl border bg-[color-mix(in_srgb,var(--surface-1)_94%,transparent)] backdrop-blur-xl"
      style={{
        borderColor: 'color-mix(in srgb, var(--primary) 55%, transparent)',
        boxShadow:
        '0 0 0 1px color-mix(in srgb, var(--primary) 18%, transparent), 0 0 34px -6px color-mix(in srgb, var(--primary) 55%, transparent), 0 30px 70px -30px rgba(0,0,0,0.95)'
      }}>
      
      {/* header */}
      <div className="flex items-start gap-2.5 px-3 pb-3 pt-3">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-s-3"
          style={{ boxShadow: `inset 0 1px 0 rgba(255,255,255,0.07), 0 0 18px -8px ${meta.accent}` }}>
          
          <span style={{ color: meta.accent }}>{meta.icon}</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-base font-medium text-foreground">
              {node.capabilityName}
            </h3>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm leading-snug text-muted-foreground">
            {node.note ??
            `${meta.label} step running in ${node.region}. ${node.leadTimeDays}-day lead time.`}
          </p>
        </div>
        <IconButton label="Close inspector" size="xs" onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>

      <div className="mol-scroll max-h-[calc(100vh-320px)] overflow-y-auto border-t border-border px-3 py-3">
        <SectionLabel>Inputs</SectionLabel>

        <div className="space-y-3">
          <div>
            <Label htmlFor="ni-merchant">Supplier</Label>
            <Select
              id="ni-merchant"
              value={merchantName}
              onChange={(e) => setMerchantName(e.target.value)}>
              
              {suppliers.map((s) =>
              <option key={s.id} value={s.name}>
                  {s.name} — {s.region}
                </option>
              )}
            </Select>
          </div>

          <div>
            <Label htmlFor="ni-kind">Operation</Label>
            <Select
              id="ni-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as PlanNode['kind'])}>
              
              {Object.entries(kindMeta).map(([k, v]) =>
              <option key={k} value={k}>
                  {v.label}
                </option>
              )}
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <Label htmlFor="ni-qty">Quantity</Label>
              <Input
                id="ni-qty"
                mono
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)} />
              
            </div>
            <div>
              <Label htmlFor="ni-cost">Unit cost</Label>
              <Input
                id="ni-cost"
                mono
                inputMode="decimal"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)} />
              
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border bg-s-2 px-2.5 py-2">
            <span className="text-sm text-muted-foreground">Node total</span>
            <span className="font-mono text-base text-foreground">{money(total)}</span>
          </div>
        </div>

        <div className="mt-4">
          <SectionLabel>Output</SectionLabel>
          <Label>Resolved node</Label>
          <pre className="mol-scroll max-h-[124px] overflow-auto rounded-md border border-input bg-s-1 p-2.5 font-mono text-sm leading-relaxed text-muted-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]">
            {output}
          </pre>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border bg-s-2/50 px-3 py-2.5">
        <Button size="xs" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="primary"
          disabled={!dirty}
          onClick={() =>
          onSave(node.nodeId, {
            merchantName,
            kind,
            quantity: qty,
            unitCost: cost,
            totalCost: total
          })
          }>
          
          Save
        </Button>
      </div>
    </motion.aside>);

}