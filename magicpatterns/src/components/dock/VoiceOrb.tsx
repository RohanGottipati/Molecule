import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../utils/cn';

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking' | 'error';

const stateColor: Record<VoiceState, string> = {
  idle: 'var(--muted-foreground)',
  listening: 'var(--cyan)',
  transcribing: 'var(--primary)',
  speaking: 'var(--violet)',
  error: 'var(--destructive)'
};

export const voiceLabel: Record<VoiceState, string> = {
  idle: 'Voice ready',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  speaking: 'Molecule speaking',
  error: 'Voice unavailable'
};

export function VoiceOrb({
  state,
  size = 34,
  onClick




}: {state: VoiceState;size?: number;onClick?: () => void;}) {
  const color = stateColor[state];
  const active = state !== 'idle' && state !== 'error';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={voiceLabel[state]}
      aria-pressed={active}
      className="relative inline-flex shrink-0 items-center justify-center rounded-full transition-transform duration-200 active:scale-95"
      style={{ width: size, height: size }}>
      
      {active &&
      <motion.span
        aria-hidden
        className="absolute inset-0 rounded-full"
        style={{ background: color, filter: 'blur(10px)' }}
        animate={{ opacity: [0.25, 0.6, 0.25], scale: [0.9, 1.15, 0.9] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }} />

      }
      <span
        className="relative flex h-full w-full items-center justify-center rounded-full border"
        style={{
          borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
          background:
          'radial-gradient(70% 70% at 50% 25%, color-mix(in srgb, var(--surface-3) 90%, transparent), var(--surface-1))',
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 0 16px -6px ${color}`
        }}>
        
        <span className="flex items-end gap-[2px]" aria-hidden>
          {[0, 1, 2, 3].map((i) =>
          <motion.span
            key={i}
            className="w-[2px] rounded-full"
            style={{ background: color }}
            animate={
            active ?
            { height: [4, 11, 6, 13, 4] } :
            { height: 4 }
            }
            transition={{
              duration: 1.1,
              repeat: active ? Infinity : 0,
              delay: i * 0.1,
              ease: 'easeInOut'
            }} />

          )}
        </span>
      </span>
    </button>);

}

export function VoiceStatus({ state }: {state: VoiceState;}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-2xs uppercase tracking-[0.1em]',
        state === 'error' ? 'text-destructive' : 'text-muted-foreground'
      )}>
      
      <span
        className="size-1 rounded-full"
        style={{
          background: stateColor[state],
          boxShadow: `0 0 8px ${stateColor[state]}`
        }} />
      
      {voiceLabel[state]}
    </span>);

}