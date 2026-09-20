import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';

export function Label({
  children,
  className,
  htmlFor




}: {children: React.ReactNode;className?: string;htmlFor?: string;}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        'block text-xs font-medium text-muted-foreground mb-1.5',
        className
      )}>
      
      {children}
    </label>);

}

export function SectionLabel({ children }: {children: React.ReactNode;}) {
  return (
    <div className="text-2xs font-mono uppercase tracking-[0.12em] text-faint mb-2">
      {children}
    </div>);

}

const fieldBase =
'w-full bg-s-1 border border-input rounded-md text-base text-foreground placeholder:text-faint ' +
'transition-all duration-200 ease-mol shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] ' +
'hover:border-border-strong focus:border-[color-mix(in_srgb,var(--primary)_60%,transparent)] ' +
'focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25),0_0_0_3px_var(--ring)] focus:outline-none';

export function Input({
  className,
  mono,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {mono?: boolean;}) {
  return (
    <input
      {...props}
      className={cn(fieldBase, 'h-8 px-2.5', mono && 'font-mono text-sm', className)} />);


}

export function Textarea({
  className,
  mono,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {mono?: boolean;}) {
  return (
    <textarea
      {...props}
      className={cn(
        fieldBase,
        'px-2.5 py-2 resize-none mol-scroll',
        mono && 'font-mono text-sm',
        className
      )} />);


}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={cn(
          fieldBase,
          'h-8 pl-2.5 pr-8 appearance-none cursor-pointer',
          className
        )}>
        
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
      
    </div>);

}

export function Toggle({
  checked,
  onChange,
  label,
  description





}: {checked: boolean;onChange: (v: boolean) => void;label: string;description?: string;}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group flex w-full items-start gap-3 rounded-md px-2 py-2 -mx-2 text-left transition-colors duration-200 hover:bg-s-2">
      
      <span
        className={cn(
          'mt-0.5 relative h-[18px] w-[32px] shrink-0 rounded-full border transition-all duration-300 ease-mol',
          checked ?
          'bg-primary border-[color-mix(in_srgb,var(--primary)_70%,transparent)] shadow-[0_0_12px_-2px_var(--primary)]' :
          'bg-s-3 border-border'
        )}>
        
        <span
          className={cn(
            'absolute top-[2px] size-[12px] rounded-full bg-white transition-all duration-300 ease-mol',
            checked ? 'left-[16px]' : 'left-[2px] bg-muted-foreground'
          )} />
        
      </span>
      <span className="min-w-0">
        <span className="block text-base text-foreground">{label}</span>
        {description &&
        <span className="block text-sm text-muted-foreground mt-0.5">
            {description}
          </span>
        }
      </span>
    </button>);

}