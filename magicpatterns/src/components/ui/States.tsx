import React from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { cn } from '../../utils/cn';

export function Skeleton({ className }: {className?: string;}) {
  return <div className={cn('mol-skeleton rounded-md', className)} />;
}

export function LoadingRows({ rows = 4 }: {rows?: number;}) {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) =>
      <div
        key={i}
        className="flex items-center gap-3 rounded-lg border border-border bg-s-1 p-3">
        
          <Skeleton className="size-8 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-2.5 w-1/3" />
            <Skeleton className="h-2 w-2/3" />
          </div>
          <Skeleton className="h-4 w-14 rounded-xs" />
        </div>
      )}
    </div>);

}

export function EmptyState({
  icon,
  title,
  description,
  action





}: {icon: React.ReactNode;title: string;description: string;action?: React.ReactNode;}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col items-center justify-center px-6 py-14 text-center">
      
      <div className="relative mb-4">
        <div className="absolute inset-0 -z-10 rounded-full bg-primary/20 blur-2xl" />
        <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-s-2 text-muted-foreground mol-raise">
          {icon}
        </div>
      </div>
      <h3 className="text-md font-medium text-foreground">{title}</h3>
      <p className="mt-1 max-w-xs text-base text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </motion.div>);

}

export function ErrorState({
  title,
  description,
  onRetry




}: {title: string;description: string;onRetry?: () => void;}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] bg-[color-mix(in_srgb,var(--destructive)_9%,var(--surface-1))] p-3.5">
      
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium text-foreground">{title}</div>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {onRetry &&
      <Button size="xs" variant="danger" icon={<RefreshCw className="size-3" />} onClick={onRetry}>
          Retry
        </Button>
      }
    </div>);

}