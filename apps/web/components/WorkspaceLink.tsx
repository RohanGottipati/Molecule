import type { ReactNode } from "react";
import { projectHref, shouldHandleNavigation } from "../lib/navigation";
import type { WorkspaceView } from "../lib/workspace";

export function WorkspaceLink({
  orderId,
  view,
  onNavigate,
  children,
  className,
  current,
  title,
}: {
  orderId: string | null;
  view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
  children: ReactNode;
  className?: string;
  current?: boolean;
  title?: string;
}) {
  const search = typeof window === "undefined" ? "" : window.location.search;
  return (
    <a
      href={projectHref(orderId, view, search)}
      className={className}
      title={title}
      aria-current={current ? "page" : undefined}
      onClick={(event) => {
        if (
          !shouldHandleNavigation(
            event,
            event.currentTarget.target,
            event.currentTarget.hasAttribute("download"),
          )
        )
          return;
        event.preventDefault();
        onNavigate(view);
      }}
    >
      {children}
    </a>
  );
}
