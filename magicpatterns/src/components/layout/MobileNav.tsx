import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  Activity,
  FolderKanban,
  LayoutGrid,
  MessagesSquare,
  Network,
  Settings,
  Store,
  Telescope } from
'lucide-react';
import { cn } from '../../utils/cn';

const items = [
{ to: '/', label: 'Projects', icon: FolderKanban, end: true },
{ to: '/workspace', label: 'Workspace', icon: MessagesSquare },
{ to: '/plan', label: 'Plan', icon: Network },
{ to: '/suppliers', label: 'Suppliers', icon: Store },
{ to: '/sources', label: 'Sources', icon: Telescope },
{ to: '/activity', label: 'Activity', icon: Activity },
{ to: '/recipes', label: 'Recipes', icon: LayoutGrid },
{ to: '/settings', label: 'Settings', icon: Settings }];


export function MobileNav() {
  return (
    <nav
      aria-label="Sections"
      className="mol-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-background px-2 py-1.5 md:hidden">
      
      {items.map((item) =>
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        className={({ isActive }) =>
        cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-sm transition-colors duration-200',
          isActive ?
          'border-border-strong bg-s-2 text-foreground' :
          'border-transparent text-muted-foreground hover:bg-s-2'
        )
        }>
        
          <item.icon className="size-3.5" />
          {item.label}
        </NavLink>
      )}
    </nav>);

}