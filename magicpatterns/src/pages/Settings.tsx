import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Panel, PanelHeader } from '../components/ui/Panel';
import { Input, Label, Select, Toggle } from '../components/ui/Field';
import { Badge } from '../components/ui/Badge';

export function Settings({
  theme,
  onThemeChange



}: {theme: 'dark' | 'light';onThemeChange: (t: 'dark' | 'light') => void;}) {
  const [shortcut, setShortcut] = useState('⌥ Space');
  const [device, setDevice] = useState('default');
  const [voice, setVoice] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [autoExpand, setAutoExpand] = useState(true);
  const [consent, setConsent] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div className="mol-scroll h-full overflow-y-auto p-4">
      <div className="mx-auto w-full max-w-[640px] space-y-3">
        <Panel className="overflow-hidden">
          <PanelHeader kicker="Dock" title="Access & voice" />
          <div className="space-y-3 p-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="st-shortcut">Global shortcut</Label>
                <Input
                  id="st-shortcut"
                  mono
                  value={shortcut}
                  onChange={(e) => setShortcut(e.target.value)} />
                
              </div>
              <div>
                <Label htmlFor="st-device">Microphone</Label>
                <Select
                  id="st-device"
                  value={device}
                  onChange={(e) => setDevice(e.target.value)}>
                  
                  <option value="default">System default</option>
                  <option value="usb">USB condenser</option>
                  <option value="headset">Headset mic</option>
                </Select>
              </div>
            </div>
            <Toggle
              checked={voice}
              onChange={setVoice}
              label="Voice input"
              description="Stream audio to the realtime agent while the dock is focused" />
            
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader kicker="Dock" title="Attention & privacy" />
          <div className="space-y-0.5 p-4">
            <Toggle
              checked={notifications}
              onChange={setNotifications}
              label="Notifications"
              description="Alert me when a plan needs approval or a supplier fails" />
            
            <Toggle
              checked={autoExpand}
              onChange={setAutoExpand}
              label="Auto-expand on alert"
              description="Open the dock automatically for blocking events" />
            
            <Toggle
              checked={consent}
              onChange={setConsent}
              label="Screen-share consent"
              description="Allow one-frame captures to be attached as context" />
            
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader
            kicker="Interface"
            title="Appearance"
            actions={<Badge tone="primary">{theme}</Badge>} />
          
          <div className="grid grid-cols-2 gap-3 p-4">
            {(['dark', 'light'] as const).map((t) =>
            <button
              key={t}
              type="button"
              onClick={() => onThemeChange(t)}
              aria-pressed={theme === t}
              className={`rounded-lg border p-2 text-left transition-all duration-200 ease-mol ${
              theme === t ?
              'border-[color-mix(in_srgb,var(--primary)_55%,transparent)] shadow-[0_0_0_3px_var(--ring)]' :
              'border-border hover:border-border-strong'}`
              }>
              
                <span
                className="block h-16 rounded-md border border-border"
                style={{
                  backgroundColor: t === 'dark' ? '#08080a' : '#f4f4f5',
                  backgroundImage: `radial-gradient(${
                  t === 'dark' ? 'rgba(255,255,255,0.09)' : 'rgba(9,9,11,0.14)'} 1px, transparent 1px)`,

                  backgroundSize: '12px 12px'
                }} />
              
                <span className="mt-2 block text-base capitalize text-foreground">
                  {t} surfaces
                </span>
              </button>
            )}
          </div>
        </Panel>

        <div className="flex justify-end gap-2 pb-4">
          <Button variant="ghost" size="md">
            Reset
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={save}
            icon={saved ? <Check className="size-3.5" /> : undefined}>
            
            {saved ? 'Saved' : 'Save settings'}
          </Button>
        </div>
      </div>
    </div>);

}