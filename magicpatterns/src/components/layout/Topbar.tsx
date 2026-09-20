import React from 'react';
import { Moon, PanelRightOpen, Plus, Search, Sun } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button, IconButton } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

export function Topbar({
  projectName,
  projectId,
  onNewProject,
  onToggleDock,
  theme,
  onToggleTheme







}: {projectName: string;projectId: string;onNewProject: () => void;onToggleDock: () => void;theme: 'dark' | 'light';onToggleTheme: () => void;}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-3">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-base font-medium text-foreground">
          {projectName}
        </h1>
        <span className="hidden font-mono text-2xs text-faint sm:inline">
          {projectId}
        </span>
        <Badge tone="primary" dot>
          Live providers
        </Badge>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <div className="relative hidden lg:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            aria-label="Search projects, suppliers and evidence"
            placeholder="Search…"
            className="h-7 w-[188px] rounded-md border border-border bg-s-1 pl-8 pr-10 text-sm text-foreground placeholder:text-faint transition-colors duration-200 hover:border-border-strong focus:border-[color-mix(in_srgb,var(--primary)_55%,transparent)] focus:outline-none" />
          
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-[4px] border border-border bg-s-3 px-1 font-mono text-2xs text-faint">
            ⌘K
          </kbd>
        </div>

        <Tooltip label={theme === 'dark' ? 'Light surfaces' : 'Dark surfaces'}>
          <IconButton
            label="Toggle theme"
            onClick={onToggleTheme}
            variant="secondary">
            
            {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          </IconButton>
        </Tooltip>

        <Tooltip label="Continue in dock">
          <IconButton label="Continue in dock" onClick={onToggleDock} variant="secondary">
            <PanelRightOpen className="size-3.5" />
          </IconButton>
        </Tooltip>

        <Button
          variant="primary"
          icon={<Plus className="size-3.5" />}
          onClick={onNewProject}>
          
          New project
        </Button>
      </div>
    </header>);

}