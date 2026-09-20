import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../../utils/cn';

export function Tooltip({
  label,
  side = 'top',
  children,
  className





}: {label: React.ReactNode;side?: 'top' | 'bottom' | 'right';children: React.ReactNode;className?: string;}) {
  const [open, setOpen] = useState(false);

  const pos =
  side === 'top' ?
  'bottom-full left-1/2 -translate-x-1/2 mb-1.5' :
  side === 'bottom' ?
  'top-full left-1/2 -translate-x-1/2 mt-1.5' :
  'left-full top-1/2 -translate-y-1/2 ml-1.5';

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}>
      
      {children}
      <AnimatePresence>
        {open &&
        <motion.span
          role="tooltip"
          initial={{ opacity: 0, scale: 0.94, y: side === 'top' ? 3 : -3 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            'pointer-events-none absolute z-50 whitespace-nowrap rounded-sm border border-border-strong',
            'bg-popover px-2 py-1 text-xs text-popover-foreground shadow-[0_8px_24px_-8px_rgba(0,0,0,0.8)]',
            pos
          )}>
          
            {label}
          </motion.span>
        }
      </AnimatePresence>
    </span>);

}