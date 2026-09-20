import React from 'react';
import { cn } from '../../utils/cn';

export function Panel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn(
        'mol-raise rounded-xl border border-border bg-s-1',
        className
      )}>
      
      {children}
    </div>);

}

export function PanelHeader({
  title,
  kicker,
  actions,
  className





}: {title: React.ReactNode;kicker?: React.ReactNode;actions?: React.ReactNode;className?: string;}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-b border-border px-4 py-3',
        className
      )}>
      
      <div className="min-w-0">
        {kicker &&
        <div className="text-2xs font-mono uppercase tracking-[0.12em] text-faint">
            {kicker}
          </div>
        }
        <h2 className="truncate text-md font-medium text-foreground">{title}</h2>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>);

}

export function Divider({ className }: {className?: string;}) {
  return <div className={cn('h-px w-full bg-border', className)} />;
}