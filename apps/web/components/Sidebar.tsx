"use client";

import type { Workspace } from "../lib/useWorkspace";
import type { WorkspaceView } from "../lib/workspace";
import { SidebarIcon, SidebarToggleIcon } from "./SidebarIcons";
import type { SidebarIconName } from "./SidebarIcons";
import { WorkspaceLink } from "./WorkspaceLink";

export const sidebarDestinations: {
  key: WorkspaceView;
  label: string;
  description: string;
  icon: SidebarIconName;
}[] = [
  {
    key: "command",
    label: "Workspace",
    description: "Shape your brief and review the latest result.",
    icon: "workspace",
  },
  {
    key: "projects",
    label: "Projects",
    description: "Your production projects, in one place.",
    icon: "projects",
  },
  {
    key: "merchants",
    label: "Suppliers",
    description: "Find capabilities and review supplier evidence.",
    icon: "suppliers",
  },
  {
    key: "reality",
    label: "Sources",
    description: "Supplier facts, sources and unresolved questions.",
    icon: "sources",
  },
  {
    key: "operations",
    label: "Activity",
    description: "Follow decisions, progress and outcomes.",
    icon: "activity",
  },
  {
    key: "execution",
    label: "Plan & actions",
    description:
      "Review the solver’s plan, approve it and inspect commerce records.",
    icon: "plan",
  },
  {
    key: "stores",
    label: "Stores",
    description: "Browse connected store catalogs, orders and customers.",
    icon: "stores",
  },
  {
    key: "testing",
    label: "Testing",
    description: "Preview the production flow chart with sample data.",
    icon: "plan",
  },
];

/**
 * The collapsible icon-rail navigation shared by the home page and the
 * project shell, so both surfaces stay in sync as the sidebar expands or
 * collapses.
 */
export function Sidebar({
  workspace,
  home,
  compose,
  collapsed,
  onCollapse,
}: {
  workspace: Workspace;
  home: boolean;
  compose: () => void;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
}) {
  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-head">
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => onCollapse(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <SidebarToggleIcon collapsed={collapsed} />
        </button>
      </div>
      <nav aria-label="Main navigation">
        <a
          href="/"
          className={`nav-item ${home ? "active" : ""}`}
          aria-current={home ? "page" : undefined}
          title={collapsed ? "Home" : undefined}
        >
          <SidebarIcon name="home" />
          <span className={`nav-label ${collapsed ? "sr-only" : ""}`}>
            Home
          </span>
        </a>
        {sidebarDestinations.map((item) => (
          <WorkspaceLink
            key={item.key}
            orderId={workspace.orderId}
            view={item.key}
            onNavigate={
              item.key === "command" && home ? compose : workspace.navigate
            }
            className={`nav-item ${!home && workspace.view === item.key ? "active" : ""}`}
            current={!home && workspace.view === item.key}
            title={collapsed ? item.label : undefined}
          >
            <SidebarIcon name={item.icon} />
            <span className={`nav-label ${collapsed ? "sr-only" : ""}`}>
              {item.label}
            </span>
          </WorkspaceLink>
        ))}
        <a
          className="nav-item"
          href="/recipes"
          title={collapsed ? "Recipe gallery" : undefined}
        >
          <SidebarIcon name="recipes" />
          <span className={`nav-label ${collapsed ? "sr-only" : ""}`}>
            Recipe gallery
          </span>
        </a>
      </nav>
    </aside>
  );
}
