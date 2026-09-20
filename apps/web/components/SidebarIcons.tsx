export type SidebarIconName =
  | "home"
  | "workspace"
  | "projects"
  | "suppliers"
  | "sources"
  | "activity"
  | "plan"
  | "recipes"
  | "stores";

const paths: Record<SidebarIconName, string> = {
  home: "m3 11 9-8 9 8M5 10v10h5v-6h4v6h5V10",
  workspace:
    "M4 5h16v11H8l-4 4V5Z",
  projects:
    "M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
  suppliers:
    "M4 10 5.5 4h13L20 10M4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9M4 10h16M9 20v-6h6v6",
  sources:
    "M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2ZM4 6v6c0 1.1 3.6 2 8 2s8-.9 8-2V6M4 12v6c0 1.1 3.6 2 8 2s8-.9 8-2v-6",
  activity: "M3 12h4l2.5 7L14 5l2.5 7H21",
  plan: "M9 11.5l2 2 4-4M5 5h14v15H5V5ZM8 3h8v3H8V3Z",
  recipes:
    "M12 6.5C10.5 5 8 4 4 4v14c4 0 6.5 1 8 2.5M12 6.5C13.5 5 16 4 20 4v14c-4 0-6.5 1-8 2.5M12 6.5v12.5",
  stores:
    "M4 9h16l-1.2-4.2A1 1 0 0 0 17.8 4H6.2a1 1 0 0 0-1 .8L4 9Zm0 0v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9M9 13h6",
};

export function SidebarIcon({ name }: { name: SidebarIconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="nav-icon"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9 4.5v15" />
      {collapsed && <path d="M13.5 9.5 16 12l-2.5 2.5" />}
      {!collapsed && <path d="M16.5 9.5 14 12l2.5 2.5" />}
    </svg>
  );
}
