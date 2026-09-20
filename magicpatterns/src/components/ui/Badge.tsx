import React from 'react';
import { cn } from '../../utils/cn';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'violet' | 'cyan';

const tones: Record<Tone, string> = {
  neutral:
  'text-muted-foreground bg-s-3 border-border',
  primary:
  'text-primary bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] border-[color-mix(in_srgb,var(--primary)_32%,transparent)]',
  success:
  'text-success bg-[color-mix(in_srgb,var(--success)_13%,transparent)] border-[color-mix(in_srgb,var(--success)_30%,transparent)]',
  warning:
  'text-warning bg-[color-mix(in_srgb,var(--warning)_13%,transparent)] border-[color-mix(in_srgb,var(--warning)_30%,transparent)]',
  danger:
  'text-destructive bg-[color-mix(in_srgb,var(--destructive)_13%,transparent)] border-[color-mix(in_srgb,var(--destructive)_32%,transparent)]',
  violet:
  'text-violet bg-[color-mix(in_srgb,var(--violet)_13%,transparent)] border-[color-mix(in_srgb,var(--violet)_30%,transparent)]',
  cyan:
  'text-cyan bg-[color-mix(in_srgb,var(--cyan)_13%,transparent)] border-[color-mix(in_srgb,var(--cyan)_30%,transparent)]'
};

interface BadgeProps {
  tone?: Tone;
  dot?: boolean;
  mono?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Badge({
  tone = 'neutral',
  dot,
  mono = true,
  className,
  children
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-xs border px-1.5 py-[1px] text-2xs font-medium uppercase tracking-[0.06em]',
        mono && 'font-mono',
        tones[tone],
        className
      )}>
      
      {dot &&
      <span className="size-1 rounded-full bg-current shadow-[0_0_6px_currentColor]" />
      }
      {children}
    </span>);

}