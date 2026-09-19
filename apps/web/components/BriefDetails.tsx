import type { Workspace } from "../lib/useWorkspace";
import { dateLabel, displayValue, humanize, money } from "../lib/workspace";
import { contextIsCompiled } from "./workspacePresentation";

export function BriefDetails({ workspace }: { workspace: Workspace }) {
  const intent = workspace.order?.intent;
  return (
    <div className="brief-details">
      {intent && (
        <details>
          <summary>Current requirements</summary>
          <dl className="brief-facts">
            <div>
              <dt>Quantity</dt>
              <dd>{intent.quantity ?? "Needs clarification"}</dd>
            </div>
            <div>
              <dt>Deadline</dt>
              <dd>{dateLabel(intent.deadline)}</dd>
            </div>
            <div>
              <dt>Budget ceiling</dt>
              <dd>{money(intent.budgetMax, intent.currency ?? undefined)}</dd>
            </div>
          </dl>
          <ul className="plain-list">
            {intent.desiredOutputs.map((output) => (
              <li key={output.outputId}>
                {output.name} · {output.quantity} units
              </li>
            ))}
          </ul>
          {intent.hardConstraints.length > 0 && (
            <>
              <h3>Required constraints</h3>
              <ul className="plain-list">
                {intent.hardConstraints.map((constraint) => (
                  <li key={constraint.constraintId}>
                    {constraint.description ??
                      `${humanize(constraint.field)} ${constraint.operator} ${displayValue(constraint.value)}`}
                  </li>
                ))}
              </ul>
            </>
          )}
          {intent.softPreferences.length > 0 && (
            <>
              <h3>Preferences</h3>
              <ul className="plain-list">
                {intent.softPreferences.map((preference) => (
                  <li key={preference.constraintId}>
                    {preference.description ??
                      `${humanize(preference.field)}: ${displayValue(preference.value)}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
      {workspace.contexts.length > 0 && (
        <details open={workspace.capabilities.hasUncompiledContexts}>
          <summary>Attached context · {workspace.contexts.length}</summary>
          <ul className="attachments">
            {workspace.contexts.map((asset) => {
              const compiled = contextIsCompiled(asset, workspace.order);
              return (
                <li key={asset.assetId}>
                  <strong>{asset.name ?? asset.assetId}</strong>
                  <span>
                    {compiled
                      ? "Included in current requirements"
                      : "Attached · not yet used in requirements"}
                  </span>
                </li>
              );
            })}
          </ul>
          {workspace.capabilities.hasUncompiledContexts && (
            <p className="inline-warning">
              Describe how to use these files and send an update. Approval is
              unavailable until the attached context has been compiled.
            </p>
          )}
        </details>
      )}
    </div>
  );
}
