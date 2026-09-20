import { isUnresolved } from "../lib/persistence";
import type { Workspace } from "../lib/useWorkspace";
import { WorkspaceLink } from "./WorkspaceLink";

export function WorkspaceNotices({ workspace }: { workspace: Workspace }) {
  const pending = workspace.pendingAction;
  return (
    <div className="workspace-notices">
      {workspace.error && (
        <div className="notice notice-error" role="alert">
          <strong>Project needs attention</strong>
          <span>{workspace.error}</span>
          {workspace.orderId && (
            <button
              type="button"
              disabled={workspace.loading}
              onClick={() => void workspace.refresh()}
            >
              Refresh project
            </button>
          )}
        </div>
      )}
      {pending?.kind === "create" && pending.orderId && !workspace.orderId ? (
        <section className="notice" aria-label="Submitted project">
          <strong>A project was created from this draft.</strong>
          <p>
            Open it to check the saved request and result, or choose New project
            for a separate brief.
          </p>
          <div className="notice-actions">
            <WorkspaceLink
              orderId={pending.orderId}
              view="command"
              onNavigate={() =>
                workspace.openProject(pending.orderId!, "command")
              }
            >
              Resume submitted project
            </WorkspaceLink>
            <button
              type="button"
              className="secondary"
              onClick={() => workspace.newProject()}
            >
              Start a new project
            </button>
          </div>
        </section>
      ) : (
        isUnresolved(pending) &&
        !workspace.busy && (
          <section
            className="notice notice-warning"
            aria-label="Unconfirmed action"
          >
            <strong>
              {pending?.status === "pending"
                ? "The server has not recorded a final outcome."
                : "The last action has an unconfirmed outcome."}
            </strong>
            <p>
              Keep this request intact. Refresh checks saved status; it does not
              undo work or automatically retry commerce actions.
            </p>
            {pending?.status === "unknown" &&
              pending.payload &&
              ["message", "create"].includes(pending.kind) && (
                <button
                  type="button"
                  onClick={() => void workspace.retryPending()}
                >
                  Check and retry the retained request
                </button>
              )}
            {pending?.kind === "recovery" && (
              <p>
                Recovery has no automatic reconciliation command. Review
                provider records with the operator.
              </p>
            )}
            <details>
              <summary>Retained action identity</summary>
              <code>{pending?.key}</code>
            </details>
          </section>
        )
      )}
      {workspace.storageError && (
        <p className="notice notice-warning" role="status">
          {workspace.storageError}
        </p>
      )}
      {workspace.marketplaceError && workspace.view !== "projects" && (
        <div className="notice notice-warning" role="status">
          <strong>
            Supplier information unavailable
            {workspace.marketplace ? " · showing last received data" : ""}
          </strong>
          <span>{workspace.marketplaceError}</span>
          <button
            type="button"
            disabled={workspace.marketplaceLoading}
            onClick={() => void workspace.refreshMarketplace()}
          >
            Retry supplier information
          </button>
        </div>
      )}
      {workspace.configError && (
        <div className="notice notice-warning" role="status">
          <span>{workspace.configError}</span>
          <button
            type="button"
            disabled={workspace.configLoading}
            onClick={() => void workspace.refreshConfig()}
          >
            Retry configuration
          </button>
        </div>
      )}
      {workspace.orderId &&
        ["reconnecting", "invalid"].includes(workspace.connection) && (
          <p className="notice notice-warning" role="status">
            Live updates are reconnecting. Molecule is checking the saved
            project; changes require a fresh read.
          </p>
        )}
    </div>
  );
}
