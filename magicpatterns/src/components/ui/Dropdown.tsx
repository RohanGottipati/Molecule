import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';

export interface DropdownItem {
  value: string;
  label: string;
  hint?: string;
}

export function Dropdown({
  items,
  value,
  onChange,
  align = 'left',
  className,
  trigger







}: {items: DropdownItem[];value: string;onChange: (v: string) => void;align?: 'left' | 'right';className?: string;trigger?: React.ReactNode;}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = items.find((i) => i.value === value);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-7 w-full items-center justify-between gap-2 rounded-md border border-border bg-s-2 px-2.5',
          'text-sm text-foreground transition-all duration-200 ease-mol hover:border-border-strong hover:bg-s-3'
        )}>
        
        {trigger ?? <span className="truncate">{current?.label ?? 'Select'}</span>}
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180'
          )} />
        
      </button>
      <AnimatePresence>
        {open &&
        <motion.ul
          role="listbox"
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            'absolute z-50 mt-1.5 min-w-[180px] overflow-hidden rounded-lg border border-border-strong bg-popover p-1',
            'shadow-[0_18px_44px_-16px_rgba(0,0,0,0.85)] backdrop-blur-xl',
            align === 'right' ? 'right-0' : 'left-0'
          )}>
          
            {items.map((item) =>
          <li key={item.value}>
                <button
              type="button"
              role="option"
              aria-selected={item.value === value}
              onClick={() => {
                onChange(item.value);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-base',
                'transition-colors duration-150 hover:bg-s-3',
                item.value === value ? 'text-foreground' : 'text-muted-foreground'
              )}>
              
                  <span className="truncate">{item.label}</span>
                  {item.value === value ?
              <Check className="size-3.5 text-primary" /> :

              item.hint &&
              <span className="font-mono text-2xs text-faint">{item.hint}</span>

              }
                </button>
              </li>
          )}
          </motion.ul>
        }
      </AnimatePresence>
    </div>);

}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className





}: {options: {value: T;label: React.ReactNode;}[];value: T;onChange: (v: T) => void;className?: string;}) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-border bg-s-1 p-0.5',
        className
      )}>
      
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className="relative inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-200">
            
            {active &&
            <motion.span
              layoutId={`seg-${options.map((o) => o.value).join('-')}`}
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              className="absolute inset-0 rounded-md border border-border-strong bg-s-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" />

            }
            <span
              className={cn(
                'relative z-10 flex items-center gap-1.5',
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}>
              
              {opt.label}
            </span>
          </button>);

      })}
    </div>);

}