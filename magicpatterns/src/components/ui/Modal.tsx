import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import { cn } from '../../utils/cn';

export function Modal({
  open,
  onClose,
  title,
  kicker,
  footer,
  width = 'max-w-lg',
  children








}: {open: boolean;onClose: () => void;title: string;kicker?: string;footer?: React.ReactNode;width?: string;children: React.ReactNode;}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open &&
      <div className="fixed inset-0 z-[80] flex items-center justify-center p-6">
          <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/65 backdrop-blur-[3px]" />
        
          <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 4 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            'relative w-full overflow-hidden rounded-2xl border border-border-strong bg-s-1',
            'shadow-[0_40px_90px_-28px_rgba(0,0,0,0.9)]',
            width
          )}>
          
            <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
              <div className="min-w-0">
                {kicker &&
              <div className="text-2xs font-mono uppercase tracking-[0.12em] text-faint">
                    {kicker}
                  </div>
              }
                <h2 className="truncate text-lg font-medium text-foreground">{title}</h2>
              </div>
              <IconButton label="Close" onClick={onClose}>
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="mol-scroll max-h-[62vh] overflow-y-auto px-4 py-4">
              {children}
            </div>
            {footer &&
          <div className="flex items-center justify-end gap-2 border-t border-border bg-s-2/60 px-4 py-3">
                {footer}
              </div>
          }
          </motion.div>
        </div>
      }
    </AnimatePresence>);

}