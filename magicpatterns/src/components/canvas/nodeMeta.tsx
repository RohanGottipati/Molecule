import React from 'react';
import {
  Boxes,
  Factory,
  Layers,
  Truck } from
'lucide-react';
import type { NodeKind, NodeStatus } from '../../types/molecule';

export const NODE_W = 248;
export const NODE_H = 74;

export const kindMeta: Record<
  NodeKind,
  {label: string;icon: React.ReactNode;accent: string;}> =
{
  SUPPLY: {
    label: 'Supply',
    icon: <Boxes className="size-4" />,
    accent: 'var(--cyan)'
  },
  TRANSFORM: {
    label: 'Transform',
    icon: <Factory className="size-4" />,
    accent: 'var(--primary)'
  },
  ASSEMBLE: {
    label: 'Assemble',
    icon: <Layers className="size-4" />,
    accent: 'var(--violet)'
  },
  FULFILL: {
    label: 'Fulfill',
    icon: <Truck className="size-4" />,
    accent: 'var(--success)'
  }
};

export const statusMeta: Record<
  NodeStatus,
  {label: string;tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';}> =
{
  idle: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'primary' },
  success: { label: 'Success', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  replaced: { label: 'Replaced', tone: 'warning' },
  offline: { label: 'Offline', tone: 'warning' }
};

export function money(n: number): string {
  return `€${n.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
}