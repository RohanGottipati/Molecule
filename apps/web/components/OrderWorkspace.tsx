"use client";

import { useEffect, useRef, useState } from "react";
import { dockProjectHref } from "../lib/navigation";
import { useWorkspace } from "../lib/useWorkspace";
import { dateLabel, type WorkspaceView } from "../lib/workspace";
import { BriefComposer } from "./BriefComposer";
import { PlanReview } from "./PlanReview";
import { ProductionConversation } from "./ProductionConversation";
import { ProjectHome } from "./ProjectHome";
import { ProjectStatus } from "./ProjectStatus";
import { WorkspaceLink } from "./WorkspaceLink";
import { WorkspaceNotices } from "./WorkspaceNotices";
import {
  EventList,
  MerchantsView,
  OperationsView,
  RealityView,
} from "./WorkspacePanels";
import { useBriefDraft } from "./useBriefDraft";
import { providerModeLabel } from "./workspacePresentation";

const destinations: {
  key: WorkspaceView;
  label: string;
  description: string;
}[] = [
  {
    key: "command",
    label: "Workspace",
    description: "Your production brief, saved requests and current result.",
  },
  {
    key: "merchants",
    label: "Suppliers",
    description: "Explore supplier capabilities and the evidence behind them.",
  },
  {
    key: "reality",
    label: "Sources",
    description:
      "Trace supplier facts to their sources, including gaps and conflicts.",
  },
  {
    key: "operations",
    label: "Activity",
    description: "Confirmed project decisions and recorded outcomes.",
  },
  {
    key: "execution",
    label: "Plan & actions",
    description:
      "Review the solver’s plan, approve it and inspect commerce records.",
  },
];

export function OrderWorkspace({
  initialOrderId,
}: {
  initialOrderId?: string;
}) {
  const workspace = useWorkspace(initialOrderId);
  const draft = useBriefDraft(workspace);
  const [selectedMerchantId, setSelectedMerchantId] = useState<string | null>(
    null,
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const focusComposer = useRef(false);
  const destination =
    destinations.find((item) => item.key === workspace.view) ??
    destinations[0]!;
  const home = !workspace.orderId && workspace.view === "command";
  const projectTitle =
    workspace.order?.intent?.desiredOutputs
      .map((output) => output.name)
      .join(", ") ||
    (workspace.orderId
      ? workspace.loading
        ? "Loading project…"
        : workspace.order
          ? "Production project"
          : "Project unavailable"
      : "No active project");
  const dockHref = workspace.orderId
    ? dockProjectHref(workspace.orderId)
    : undefined;
  useEffect(() => {
    if (focusComposer.current && workspace.view === "command") {
      if (draft.ready) {
        textarea.current?.focus();
        focusComposer.current = false;
      }
    } else heading.current?.focus();
  }, [workspace.view, workspace.orderId, workspace.draftScope, draft.ready]);

  function compose() {
    if (workspace.view === "command") textarea.current?.focus();
    else {
      focusComposer.current = true;
      workspace.navigate("command");
    }
  }
  function startProject() {
    if (workspace.orderId || workspace.pendingAction?.orderId) {
      focusComposer.current = true;
      workspace.newProject();
    } else compose();
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      <aside className="sidebar">
        <a href="/" className="brand" aria-label="Molecule projects">
          <span className="brand-mark" aria-hidden="true">
            m·
          </span>
          <span>molecule</span>
        </a>
        <nav aria-label="Main navigation">
          <a
            href="/"
            className={`nav-item ${home ? "active" : ""}`}
            aria-current={home ? "page" : undefined}
          >
            Projects
          </a>
          {destinations.map((item) => (
            <WorkspaceLink
              key={item.key}
              orderId={workspace.orderId}
              view={item.key}
              onNavigate={
                item.key === "command" && home ? compose : workspace.navigate
              }
              className={`nav-item ${!home && workspace.view === item.key ? "active" : ""}`}
              current={!home && workspace.view === item.key}
            >
              {item.label}
            </WorkspaceLink>
          ))}
          <a className="nav-item" href="/recipes">Recipe gallery</a>
        </nav>
        <div className="sidebar-footer">
          <p>Brief → validated plan → approval → commerce records</p>
          <p>No payment or physical delivery is confirmed here.</p>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="active-project">
            <span className="eyebrow">ACTIVE PROJECT</span>
            <strong>{projectTitle}</strong>
            {workspace.orderId && (
              <small>#{workspace.orderId.slice(0, 8)}</small>
            )}
          </div>
          <div className="topbar-actions">
            <span className="mode-tag">{providerModeLabel(workspace)}</span>
            {dockHref && (
              <a className="secondary" href={dockHref}>
                Continue in dock
              </a>
            )}
            <button className="secondary" type="button" onClick={startProject}>
              New project
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <h1 ref={heading} tabIndex={-1}>
                {home ? "Projects" : destination.label}
              </h1>
              <p>
                {home
                  ? "Bring a production brief. Return to the work already underway."
                  : destination.description}
              </p>
            </div>
            {workspace.view !== "command" && (
              <button className="secondary" type="button" onClick={compose}>
                {workspace.canSubmitMessage
                  ? "Return to brief"
                  : "View brief & saved draft"}
              </button>
            )}
          </div>
          <WorkspaceNotices workspace={workspace} />
          {workspace.orderId && (
            <ProjectStatus
              key={workspace.orderId}
              workspace={workspace}
              onCompose={compose}
            />
          )}
          {workspace.view === "command" &&
            (home ? (
              <div className="home-layout">
                <ProjectHome workspace={workspace} />
                <section
                  id="new-brief"
                  className="new-project"
                  aria-labelledby="new-project-title"
                >
                  <div className="intro-copy">
                    <p className="eyebrow">NEW PRODUCTION PROJECT</p>
                    <h2 id="new-project-title">
                      Tell us what needs to be made.
                    </h2>
                    <p>
                      Molecule turns quantities, deadlines and requirements into
                      supplier quotes and a solver-validated production plan.
                      Review it before approving commerce records.
                    </p>
                    <p className="muted small">
                      A project is created only when you send the brief.
                    </p>
                  </div>
                  <BriefComposer
                    workspace={workspace}
                    draft={draft}
                    textarea={textarea}
                  />
                </section>
              </div>
            ) : (
              <div className="workspace-conversation">
                <ProductionConversation
                  key={workspace.orderId}
                  workspace={workspace}
                />
                <BriefComposer
                  workspace={workspace}
                  draft={draft}
                  textarea={textarea}
                />
              </div>
            ))}
          {workspace.view === "merchants" && (
            <>
              <p className="scope-note">
                Marketplace supplier directory · shared across projects. Plan
                &amp; actions shows this project&apos;s selected suppliers.
              </p>
              <MerchantsView
                marketplace={workspace.marketplace}
                loading={workspace.marketplaceLoading}
                selectedMerchantId={selectedMerchantId}
                onSelect={setSelectedMerchantId}
              />
            </>
          )}
          {workspace.view === "reality" && (
            <RealityView
              marketplace={workspace.marketplace}
              loading={workspace.marketplaceLoading}
            />
          )}
          {workspace.view === "operations" && (
            <div className="stack">
              <section className="panel">
                <div className="section-heading">
                  <h2 id="project-activity-title" tabIndex={-1}>
                    Project activity
                  </h2>
                  <span className="muted small">
                    {workspace.orderId
                      ? "Saved server events"
                      : "Open a project to see its activity"}
                  </span>
                </div>
                {workspace.loading ? (
                  <p className="inset muted">Loading recorded activity…</p>
                ) : (
                  <EventList events={workspace.events} limit={20} />
                )}
              </section>
              <details className="operations-disclosure">
                <summary>
                  Marketplace operations &amp; provider health · all projects
                </summary>
                <OperationsView marketplace={workspace.marketplace} />
              </details>
            </div>
          )}
          {workspace.view === "execution" && (
            <PlanReview
              key={`${workspace.orderId}:${workspace.order?.activePlan?.planId ?? "no-plan"}`}
              workspace={workspace}
              onCompose={compose}
              onSuggest={(value) => {
                draft.suggest(value);
                compose();
              }}
              onMerchant={(id) => {
                setSelectedMerchantId(id);
                workspace.navigate("merchants");
              }}
            />
          )}
          <footer className="workspace-footer">
            <span>
              {workspace.orderId
                ? workspace.freshness === "fresh"
                  ? "Project is up to date"
                  : workspace.freshness === "stale"
                    ? "Latest project read failed"
                    : "Checking saved project…"
                : "Production planning workspace"}
            </span>
            {workspace.orderId && (
              <button
                type="button"
                className="text-button"
                disabled={
                  workspace.loading || workspace.freshness === "refreshing"
                }
                onClick={() => void workspace.refresh()}
              >
                Refresh project
              </button>
            )}
            <details>
              <summary>Connection &amp; project details</summary>
              <p>
                Recovery simulations:{" "}
                {workspace.configLoading
                  ? "checking configuration"
                  : workspace.configError
                    ? "configuration unavailable; controls disabled"
                    : workspace.demoMode
                      ? "enabled by server"
                      : "disabled by server"}
                .
              </p>
              <p>
                Updates: {workspace.connection}.{" "}
                {workspace.lastSyncedAt
                  ? `Last read ${dateLabel(new Date(workspace.lastSyncedAt).toISOString(), true)}.`
                  : ""}
              </p>
              {workspace.orderId && (
                <p>
                  Project <code>{workspace.orderId}</code> · trace{" "}
                  <code>{workspace.order?.traceId ?? "Not loaded"}</code>
                </p>
              )}
              {workspace.syncError && <p>{workspace.syncError}</p>}
            </details>
          </footer>
        </main>
      </div>
    </div>
  );
}
