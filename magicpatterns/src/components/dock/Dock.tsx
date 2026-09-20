import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowUp,
  ChevronDown,
  Minus,
  MonitorUp,
  Paperclip,
  Settings2,
  Sparkles,
  X } from
'lucide-react';
import { Badge } from '../ui/Badge';
import { Button, IconButton } from '../ui/Button';
import { Textarea, Toggle } from '../ui/Field';
import { Tooltip } from '../ui/Tooltip';
import { ErrorState } from '../ui/States';
import { VoiceOrb, VoiceStatus, type VoiceState } from './VoiceOrb';
import { conversation, hardConstraints } from '../../data/workspace';
import { cn } from '../../utils/cn';

export function Dock({
  open,
  onClose,
  onOpenCommandCenter




}: {open: boolean;onClose: () => void;onOpenCommandCenter: () => void;}) {
  const [compact, setCompact] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [voice, setVoice] = useState<VoiceState>('listening');
  const [draft, setDraft] = useState('');
  const [constraints, setConstraints] = useState(hardConstraints);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [autoExpand, setAutoExpand] = useState(true);
  const [screenConsent, setScreenConsent] = useState(false);
  const [notice, setNotice] = useState(true);

  return (
    <AnimatePresence>
      {open &&
      <motion.aside
        aria-label="Molecule dock"
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 14, scale: 0.98 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          'fixed bottom-4 right-4 z-[70] flex w-[352px] flex-col overflow-hidden rounded-2xl',
          'border border-border-strong bg-[color-mix(in_srgb,var(--surface-1)_88%,transparent)] backdrop-blur-2xl',
          'shadow-[0_40px_100px_-30px_rgba(0,0,0,0.95)]'
        )}>
        
          {/* header */}
          <div className="flex h-10 items-center gap-2 border-b border-border px-2.5">
            <span className="relative flex size-5 items-center justify-center rounded-[6px] border border-border bg-s-3 font-mono text-2xs">
              m
              <span className="absolute inset-0 -z-10 rounded-[6px] bg-primary/40 blur-md" />
            </span>
            <span className="text-sm font-medium">Molecule</span>
            <Badge tone="success" dot className="ml-0.5">
              Connected
            </Badge>
            <div className="ml-auto flex items-center gap-0.5">
              <Tooltip label="Command Center">
                <IconButton label="Command Center" size="xs" onClick={onOpenCommandCenter}>
                  <Sparkles className="size-3.5" />
                </IconButton>
              </Tooltip>
              <Tooltip label="Dock settings">
                <IconButton
                label="Dock settings"
                size="xs"
                onClick={() => setShowSettings((s) => !s)}
                className={showSettings ? 'text-foreground bg-s-2' : undefined}>
                
                  <Settings2 className="size-3.5" />
                </IconButton>
              </Tooltip>
              <IconButton
              label={compact ? 'Expand dock' : 'Collapse dock'}
              size="xs"
              onClick={() => setCompact((c) => !c)}>
              
                {compact ?
              <ChevronDown className="size-3.5 rotate-180" /> :

              <Minus className="size-3.5" />
              }
              </IconButton>
              <IconButton label="Hide dock" size="xs" onClick={onClose}>
                <X className="size-3.5" />
              </IconButton>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {!compact &&
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden">
            
                {showSettings ?
            <div className="space-y-4 px-3 py-3">
                    <Fieldset title="Access & voice">
                      <Toggle
                  checked={voiceEnabled}
                  onChange={setVoiceEnabled}
                  label="Voice input"
                  description="Global shortcut ⌥ Space" />
                
                      <Toggle
                  checked={autoExpand}
                  onChange={setAutoExpand}
                  label="Auto-expand on alert"
                  description="Open the dock when a plan needs you" />
                
                    </Fieldset>
                    <Fieldset title="Attention & privacy">
                      <Toggle
                  checked={screenConsent}
                  onChange={setScreenConsent}
                  label="Screen-share consent"
                  description="Allow one-frame captures as context" />
                
                    </Fieldset>
                  </div> :

            <div className="mol-scroll max-h-[340px] overflow-y-auto px-3 py-3">
                    {notice &&
              <div className="mb-3">
                        <ErrorState
                  title="Kestrel Trims went offline"
                  description="A replacement supplier is staged on node nd_trim."
                  onRetry={() => setNotice(false)} />
                
                      </div>
              }

                    <ul className="space-y-2.5">
                      {conversation.map((turn) =>
                <li
                  key={turn.id}
                  className={cn(
                    'rounded-xl border px-2.5 py-2',
                    turn.role === 'user' ?
                    'border-border bg-s-2' :
                    'border-border bg-s-1'
                  )}>
                  
                          <div className="mb-1 flex items-center gap-1.5">
                            <span className="font-mono text-2xs uppercase tracking-[0.1em] text-faint">
                              {turn.role === 'user' ? 'You' : 'Molecule'}
                            </span>
                            {turn.voice && <Badge tone="cyan">voice</Badge>}
                            <span className="ml-auto font-mono text-2xs text-faint">
                              {turn.at}
                            </span>
                          </div>
                          <p className="text-base leading-relaxed text-foreground">
                            {turn.text}
                          </p>
                          {turn.question &&
                  <p className="mt-1.5 rounded-md border border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--warning)_9%,transparent)] px-2 py-1.5 text-sm text-warning">
                              {turn.question}
                            </p>
                  }
                          {turn.attachments &&
                  <div className="mt-1.5 flex flex-wrap gap-1">
                              {turn.attachments.map((a) =>
                    <span
                      key={a}
                      className="rounded-xs border border-border bg-s-3 px-1.5 py-[1px] font-mono text-2xs text-muted-foreground">
                      
                                  {a}
                                </span>
                    )}
                            </div>
                  }
                        </li>
                )}
                    </ul>

                    <div className="mt-3">
                      <div className="mb-1.5 text-2xs font-mono uppercase tracking-[0.12em] text-faint">
                        Hard constraints
                      </div>
                      <ul className="flex flex-wrap gap-1.5">
                        {constraints.map((c) =>
                  <li key={c}>
                            <button
                      type="button"
                      onClick={() =>
                      setConstraints((list) => list.filter((i) => i !== c))
                      }
                      className="group inline-flex items-center gap-1 rounded-xs border border-border bg-s-2 px-1.5 py-[2px] text-xs text-muted-foreground transition-colors duration-200 hover:border-border-strong hover:text-foreground">
                      
                              {c}
                              <X className="size-2.5 opacity-50 group-hover:opacity-100" />
                            </button>
                          </li>
                  )}
                      </ul>
                    </div>

                    <Button
                variant="primary"
                size="md"
                className="mt-3 w-full"
                onClick={onOpenCommandCenter}>
                
                      Approve &amp; execute plan
                    </Button>
                  </div>
            }
              </motion.div>
          }
          </AnimatePresence>

          {/* input */}
          <div className="border-t border-border p-2.5">
            <div className="flex items-center justify-between px-0.5 pb-1.5">
              <VoiceStatus state={voiceEnabled ? voice : 'idle'} />
              <span className="font-mono text-2xs text-faint">prj_atlas</span>
            </div>
            <div className="rounded-xl border border-input bg-s-1 p-1.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] transition-colors duration-200 focus-within:border-[color-mix(in_srgb,var(--primary)_55%,transparent)]">
              <Textarea
              aria-label="Message Molecule"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={compact ? 1 : 2}
              placeholder={compact ? 'Ask Molecule…' : 'What would you like to make?'}
              className="border-0 bg-transparent p-1 shadow-none focus:shadow-none" />
            
              <div className="flex items-center gap-1 pt-1">
                <VoiceOrb
                state={voiceEnabled ? voice : 'idle'}
                size={28}
                onClick={() =>
                setVoice((v) => v === 'listening' ? 'idle' : 'listening')
                } />
              
                <Tooltip label="Attach file">
                  <IconButton label="Attach file" size="xs">
                    <Paperclip className="size-3.5" />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Share one frame">
                  <IconButton label="Share one frame" size="xs">
                    <MonitorUp className="size-3.5" />
                  </IconButton>
                </Tooltip>
                <IconButton
                label="Send"
                size="xs"
                variant="primary"
                className="ml-auto"
                disabled={!draft.trim()}
                onClick={() => setDraft('')}>
                
                  <ArrowUp className="size-3.5" />
                </IconButton>
              </div>
            </div>
          </div>
        </motion.aside>
      }
    </AnimatePresence>);

}

function Fieldset({
  title,
  children



}: {title: string;children: React.ReactNode;}) {
  return (
    <fieldset>
      <legend className="mb-1 text-2xs font-mono uppercase tracking-[0.12em] text-faint">
        {title}
      </legend>
      <div className="space-y-0.5">{children}</div>
    </fieldset>);

}