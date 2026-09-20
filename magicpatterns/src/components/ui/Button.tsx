import React from 'react';
import { cn } from '../../utils/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'glass';
type Size = 'xs' | 'sm' | 'md';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: React.ReactNode;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary:
  'bg-primary text-primary-foreground border border-[rgba(255,255,255,0.14)] shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_1px_2px_rgba(0,0,0,0.45)] hover:brightness-110 active:brightness-95',
  secondary:
  'bg-s-2 text-foreground border border-border hover:bg-s-3 hover:border-border-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
  ghost:
  'bg-transparent text-muted-foreground border border-transparent hover:bg-s-2 hover:text-foreground',
  danger:
  'bg-[color-mix(in_srgb,var(--destructive)_16%,transparent)] text-destructive border border-[color-mix(in_srgb,var(--destructive)_35%,transparent)] hover:bg-[color-mix(in_srgb,var(--destructive)_24%,transparent)]',
  glass:
  'bg-[color-mix(in_srgb,var(--surface-2)_75%,transparent)] backdrop-blur-xl text-foreground border border-border hover:border-border-strong'
};

const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-xs gap-1 rounded-sm',
  sm: 'h-7 px-2.5 text-sm gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-base gap-2 rounded-lg'
};

export function Button({
  variant = 'secondary',
  size = 'sm',
  icon,
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-medium whitespace-nowrap',
        'transition-all duration-200 ease-mol select-none',
        'disabled:opacity-45 disabled:pointer-events-none',
        'active:scale-[0.98]',
        sizes[size],
        variants[variant],
        className
      )}>
      
      {loading ?
      <span
        aria-hidden
        className="size-3 rounded-full border border-current border-t-transparent animate-spin" /> :


      icon
      }
      {children}
    </button>);

}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: Variant;
  size?: Size;
}

export function IconButton({
  label,
  variant = 'ghost',
  size = 'sm',
  className,
  children,
  ...props
}: IconButtonProps) {
  const box = size === 'xs' ? 'size-6 rounded-sm' : size === 'md' ? 'size-9 rounded-lg' : 'size-7 rounded-md';
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center transition-all duration-200 ease-mol active:scale-95',
        'disabled:opacity-40 disabled:pointer-events-none',
        box,
        variants[variant],
        className
      )}>
      
      {children}
    </button>);

}