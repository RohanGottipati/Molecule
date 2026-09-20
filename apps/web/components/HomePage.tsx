"use client";

import type { RefObject } from "react";
import type { Workspace } from "../lib/useWorkspace";
import type { useBriefDraft } from "./useBriefDraft";
import { HomeComposer } from "./HomeComposer";
import { WorkspaceLink } from "./WorkspaceLink";
import { WorkspaceNotices } from "./WorkspaceNotices";

/**
 * Focused landing composer before entering the production workspace.
 */
export function HomePage({
  workspace,
  draft,
  textarea,
}: {
  workspace: Workspace;
  draft: ReturnType<typeof useBriefDraft>;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div className="app-shell dashboard-shell home-shell">
      <a className="skip-link" href="#home-main">
        Skip to workspace
      </a>
      <header className="home-header">
        <WorkspaceLink
          orderId={null}
          view="projects"
          onNavigate={workspace.navigate}
          className="home-next"
        >
          Next
        </WorkspaceLink>
      </header>
      <div className="main-shell">
        <main id="home-main" className="home-layout" tabIndex={-1}>
          <WorkspaceNotices workspace={workspace} />
          <HomeComposer
            workspace={workspace}
            draft={draft}
            textarea={textarea}
          />
        </main>
      </div>
    </div>
  );
}
