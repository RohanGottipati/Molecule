import { projectHref, shouldHandleNavigation } from "../lib/navigation";
import type { Workspace } from "../lib/useWorkspace";
import { dateLabel, stateLabels } from "../lib/workspace";
import { resumeLabel } from "./workspacePresentation";

export function ProjectHome({ workspace }: { workspace: Workspace }) {
  return (
    <section
      className="project-history"
      aria-labelledby="project-history-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="project-history-title">Your projects</h2>
          <p className="muted">
            Return to a brief, review a plan or find its records.
          </p>
        </div>
        <button
          className="text-button"
          type="button"
          disabled={workspace.projectsLoading}
          onClick={() => void workspace.refreshProjects()}
        >
          Refresh list
        </button>
      </div>
      <label className="project-search">
        <span>Search saved projects</span>
        <input
          type="search"
          value={workspace.projectSearch}
          maxLength={100}
          placeholder="Product name or project ID"
          onChange={(event) => workspace.setProjectSearch(event.target.value)}
        />
      </label>
      {workspace.projectsError && (
        <div className="notice notice-warning" role="status">
          <span>{workspace.projectsError}</span>
          <button
            type="button"
            disabled={workspace.projectsLoading}
            onClick={() => void workspace.refreshProjects()}
          >
            Retry project list
          </button>
        </div>
      )}
      {workspace.projectsLoading && (
        <p className="muted inset" role="status">
          Loading saved projects…
        </p>
      )}
      {!workspace.projectsLoading &&
        !workspace.projectsError &&
        !workspace.projects.length && (
          <p className="inset muted">
            {workspace.projectSearch
              ? "No projects match this search. Try another name or clear the search."
              : "No saved projects yet. Send a production brief when you are ready."}
          </p>
        )}
      <ul className="project-list" aria-busy={workspace.projectsLoading}>
        {workspace.projects.map((project) => {
          const target = [
            "AWAITING_APPROVAL",
            "COMPLETED",
            "NEEDS_HUMAN",
            "FAILED",
          ].includes(project.state)
            ? "execution"
            : "command";
          return (
            <li key={project.orderId}>
              <a
                href={projectHref(project.orderId, target)}
                onClick={(event) => {
                  if (!shouldHandleNavigation(event)) return;
                  event.preventDefault();
                  workspace.openProject(project.orderId, target);
                }}
              >
                <span className="project-list-title">
                  <strong>{project.title}</strong>
                  <span>
                    {project.state === "COMPLETED"
                      ? "Completed · see commerce records"
                      : stateLabels[project.state]}
                  </span>
                  <small>Updated {dateLabel(project.updatedAt, true)}</small>
                </span>
                <span className="project-resume">
                  {resumeLabel(project)} <span aria-hidden="true">→</span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {workspace.projectsNextCursor && (
        <button
          className="secondary"
          type="button"
          disabled={workspace.projectsLoading}
          onClick={() => void workspace.loadMoreProjects()}
        >
          Load more projects
        </button>
      )}
    </section>
  );
}
