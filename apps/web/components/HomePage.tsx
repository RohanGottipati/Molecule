"use client";

import type { RefObject } from "react";
import type { Workspace } from "../lib/useWorkspace";
import type { useBriefDraft } from "./useBriefDraft";
import { HomeComposer } from "./HomeComposer";
import { WorkspaceNotices } from "./WorkspaceNotices";
import { AsciiCursorTrail } from "./AsciiCursorTrail";

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
      <video
        className="home-background-video"
        src="/backvid.mp4"
        autoPlay
        loop
        muted
        playsInline
        aria-hidden="true"
        tabIndex={-1}
      />
      <AsciiCursorTrail />
      <a className="skip-link" href="#home-main">
        Skip to workspace
      </a>
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
