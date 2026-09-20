import { useRef } from "react";
import type { Workspace } from "../lib/useWorkspace";
import { WorkspaceLink } from "./WorkspaceLink";
import { projectNextStep, savedResultTitle } from "./workspacePresentation";

export function ProjectStatus({
  workspace,
  onCompose,
}: {
  workspace: Workspace;
  onCompose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const next = projectNextStep(workspace);
  return (
    <section
      className="project-status"
      aria-label="Project status and next step"
    >
      <div className="project-status-copy">
        <p className="eyebrow">CURRENT TASK</p>
        <h2>
          {workspace.loading && !workspace.order
            ? "Loading project…"
            : next.title}
        </h2>
        <p className="sr-only" role="status">
          {workspace.order &&
          [
            "AWAITING_APPROVAL",
            "NEEDS_CLARIFICATION",
            "PLAN_UNSAT",
            "COMPLETED",
            "CANCELLED",
            "FAILED",
            "NEEDS_HUMAN",
          ].includes(workspace.order.state)
            ? savedResultTitle(workspace.order, workspace.events)
            : ""}
        </p>
        <p>{next.detail}</p>
      </div>
      <div className="project-status-actions">
        {next.action === "composer" ? (
          <button type="button" className="primary" onClick={onCompose}>
            {next.label}
          </button>
        ) : next.action === "refresh" ? (
          <button
            type="button"
            className="secondary"
            disabled={workspace.loading || workspace.freshness === "refreshing"}
            onClick={() => void workspace.refresh()}
          >
            {next.label}
          </button>
        ) : workspace.view === next.action ? (
          <a
            className="primary"
            href={
              next.action === "execution"
                ? "#plan-review-title"
                : "#project-activity-title"
            }
          >
            {next.label}
          </a>
        ) : (
          <WorkspaceLink
            className="primary"
            orderId={workspace.orderId}
            view={next.action}
            onNavigate={workspace.navigate}
          >
            {next.label}
          </WorkspaceLink>
        )}
        {workspace.canCancelPlanning && (
          <button
            className="text-button"
            type="button"
            onClick={() => dialog.current?.showModal()}
          >
            Cancel planning
          </button>
        )}
      </div>
      <dialog
        ref={dialog}
        className="confirmation-dialog"
        aria-labelledby="cancel-planning-title"
      >
        <h2 id="cancel-planning-title">Cancel this planning request?</h2>
        <p>
          Stop planning and close this brief. Saved requests, evidence and
          activity remain available.
        </p>
        <p>This does not reverse commerce records or any external work.</p>
        <form method="dialog" className="dialog-actions">
          <button className="secondary" autoFocus>
            Keep planning
          </button>
          <button
            className="danger-outline"
            disabled={!workspace.canCancelPlanning}
            onClick={() => void workspace.cancelPlanning()}
          >
            Cancel planning
          </button>
        </form>
      </dialog>
    </section>
  );
}
