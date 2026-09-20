import React from 'react';
import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
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

const primary = [
{ to: '/', label: 'Projects', icon: FolderKanban, end: true },
{ to: '/workspace', label: 'Workspace', icon: MessagesSquare },
{ to: '/plan', label: 'Plan & actions', icon: Network }];


const secondary = [
{ to: '/suppliers', label: 'Suppliers', icon: Store },
{ to: '/sources', label: 'Sources', icon: Telescope },
{ to: '/activity', label: 'Activity', icon: Activity },
{ to: '/recipes', label: 'Recipe gallery', icon: LayoutGrid }];


export function Sidebar() {
  return (
    <nav
      aria-label="Primary"
      className="hidden w-[208px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
      
      <div className="flex h-12 items-center gap-2 px-3.5">
        <span className="relative flex size-6 items-center justify-center rounded-md border border-border bg-s-3 font-mono text-sm text-foreground">
          m
          <span className="absolute inset-0 -z-10 rounded-md bg-primary/40 blur-md" />
        </span>
        <span className="text-md font-medium tracking-tight">Molecule</span>
      </div>

      <div className="mol-scroll flex-1 overflow-y-auto px-2 pb-3 pt-1">
        <Group items={primary} />
        <div className="my-3 px-2 text-2xs font-mono uppercase tracking-[0.12em] text-faint">
          Evidence
        </div>
        <Group items={secondary} />
      </div>

      <div className="border-t border-sidebar-border p-2">
        <Group
          items={[{ to: '/settings', label: 'Settings', icon: Settings }]} />
        
        <p className="mt-2 px-2 pb-1 text-2xs leading-relaxed text-faint">
          Brief → validated plan → approval → commerce records
        </p>
      </div>
    </nav>);

}

function Group({
  items


}: {items: {to: string;label: string;icon: React.ElementType;end?: boolean;}[];}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) =>
      <li key={item.to}>
          <NavLink
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
          cn(
            'group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-base transition-colors duration-200',
            isActive ?
            'text-foreground' :
            'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'
          )
          }>
          
            {({ isActive }) =>
          <>
                {isActive &&
            <motion.span
              layoutId="nav-active"
              transition={{ type: 'spring', stiffness: 400, damping: 34 }}
              className="absolute inset-0 rounded-md border border-border bg-s-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]" />

            }
                <item.icon
              className={cn(
                'relative z-10 size-4 shrink-0 transition-colors',
                isActive ? 'text-primary' : 'text-faint group-hover:text-muted-foreground'
              )} />
            
                <span className="relative z-10 truncate">{item.label}</span>
              </>
          }
          </NavLink>
        </li>
      )}
    </ul>);

}