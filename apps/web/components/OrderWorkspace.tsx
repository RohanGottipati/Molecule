"use client";

import { useEffect, useRef, useState } from "react";
import { dockProjectHref } from "../lib/navigation";
import { useWorkspace } from "../lib/useWorkspace";
import { dateLabel } from "../lib/workspace";
import { BriefClarificationDialog } from "./BriefClarificationDialog";
import { BriefComposer } from "./BriefComposer";
import { HomePage } from "./HomePage";
import { StoreConsole } from "./StoreConsole";
import { TestingPlan } from "./TestingPlan";
import { PlanReview } from "./PlanReview";
import { ProductionConversation } from "./ProductionConversation";
import { ProjectHome } from "./ProjectHome";
import { ProjectStatus } from "./ProjectStatus";
import { Sidebar, sidebarDestinations } from "./Sidebar";
import { WorkspaceNotices } from "./WorkspaceNotices";
import {
  EventList,
  MerchantsView,
  OperationsView,
  RealityView,
} from "./WorkspacePanels";
import { useBriefDraft } from "./useBriefDraft";
import { providerModeLabel } from "./workspacePresentation";

const SIDEBAR_COLLAPSED_KEY = "molecule.sidebarCollapsed";

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (stored === "1") setSidebarCollapsed(true);
    } catch {
      // Ignore storage failures (private browsing, disabled storage).
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_KEY,
        sidebarCollapsed ? "1" : "0",
      );
    } catch {
      // Ignore storage failures (private browsing, disabled storage).
    }
  }, [sidebarCollapsed]);
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const sync = () => setIsNarrowViewport(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  // Below the mobile breakpoint the sidebar already becomes a static, full-width
  // bar with its own layout, so the desktop icon-rail collapse is suppressed
  // rather than persisted over it.
  const sidebarIsCollapsed = sidebarCollapsed && !isNarrowViewport;
  const heading = useRef<HTMLHeadingElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const focusComposer = useRef(false);
  const destination =
    sidebarDestinations.find((item) => item.key === workspace.view) ??
    sidebarDestinations[0]!;
  const canvasView =
    workspace.view === "testing" || workspace.view === "execution";
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
      : "Production workspace");
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

  // Auto-navigate to Plan & actions the first time a plan appears for the
  // order being watched, so submitting a brief on Home lands the user on the
  // plan without a manual sidebar click. Only fires once a loaded snapshot of
  // the order was seen without a plan, so a page reload or deep link whose
  // first loaded snapshot already carries a plan stays on the requested view.
  // Never fires twice for the same order.
  const priorPlanRef = useRef<{
    orderId: string | null;
    planId: string | null;
    loaded: boolean;
  }>({ orderId: null, planId: null, loaded: false });
  const autoNavigatedRef = useRef<Set<string>>(new Set());
  const loadedOrderId = workspace.order?.orderId ?? null;
  const activePlanId = workspace.order?.activePlan?.planId ?? null;
  useEffect(() => {
    const orderId = workspace.orderId;
    const loaded = orderId !== null && loadedOrderId === orderId;
    const planId = loaded ? activePlanId : null;
    const prior = priorPlanRef.current;
    if (prior.orderId !== orderId || !prior.loaded) {
      priorPlanRef.current = { orderId, planId, loaded };
      return;
    }
    if (
      planId &&
      !prior.planId &&
      orderId &&
      !autoNavigatedRef.current.has(orderId)
    ) {
      autoNavigatedRef.current.add(orderId);
      if (workspace.view === "command") workspace.navigate("execution");
    }
    priorPlanRef.current = { orderId, planId, loaded };
  }, [workspace.orderId, loadedOrderId, activePlanId, workspace.view]);

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

  if (home)
    return <HomePage workspace={workspace} draft={draft} textarea={textarea} />;

  return (
    <div
      className={`app-shell dashboard-shell ${canvasView ? "canvas-shell" : ""} ${sidebarIsCollapsed ? "sidebar-collapsed" : ""}`}
    >
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      <Sidebar
        workspace={workspace}
        home={home}
        compose={compose}
        collapsed={sidebarIsCollapsed}
        onCollapse={setSidebarCollapsed}
      />
      <div className="main-shell">
        {!canvasView && (
          <header className="topbar">
            <div className="active-project">
              <span className="eyebrow">
                {workspace.orderId ? "PROJECT" : "MOLECULE"}
              </span>
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
              <button
                className="secondary"
                type="button"
                onClick={startProject}
              >
                New project
              </button>
            </div>
          </header>
        )}
        <main id="main-content" className="main-content" tabIndex={-1}>
          <BriefClarificationDialog draft={draft} />
          {!canvasView && (
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
          )}
          {!canvasView && <WorkspaceNotices workspace={workspace} />}
          {workspace.orderId && workspace.view === "command" && (
            <ProjectStatus
              key={workspace.orderId}
              workspace={workspace}
              onCompose={compose}
            />
          )}
          {workspace.view === "command" && (
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
          )}
          {workspace.view === "projects" && (
            <ProjectHome workspace={workspace} />
          )}
          {workspace.view === "merchants" && (
            <>
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
                      ? "Project history"
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
                <summary>Provider health &amp; marketplace</summary>
                <OperationsView marketplace={workspace.marketplace} />
              </details>
            </div>
          )}
          {workspace.view === "stores" && <StoreConsole />}
          {workspace.view === "testing" && <TestingPlan />}
          {workspace.view === "execution" && (
            <PlanReview
              key={workspace.orderId ?? "no-project"}
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
          {!canvasView && (
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
                <summary>Connection details</summary>
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
          )}
        </main>
      </div>
    </div>
  );
}
