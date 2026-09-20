import { GraphDetailPanel } from "./GraphDetailPanel";
import { useMemo, useState } from "react";
import type { PlanSelection } from "../lib/decisionPlan";
import { relaxationDraft } from "../lib/navigation";
import type { Workspace } from "../lib/useWorkspace";
import { dateLabel, displayValue, money } from "../lib/workspace";
import { PlanGraph } from "./PlanGraph";
import { WorkspaceNotices } from "./WorkspaceNotices";
import { Badge, Empty, ExecutionView, NodeDetail } from "./WorkspacePanels";
import {
  decisionActionsBlocked,
  recoveryComparison,
  resolveSelectedNode,
} from "./workspacePresentation";

function PlanActionsPanel({
  workspace,
  onCompose,
  onSuggest,
  onMerchant,
}: {
  workspace: Workspace;
  onCompose: () => void;
  onSuggest: (value: string) => void;
  onMerchant: (id: string) => void;
}) {
  const { order, marketplace, previousPlan, events } = workspace;
  const plan = order?.activePlan ?? null;
  const comparison = recoveryComparison(previousPlan, plan, events);
  const actionsBlocked = decisionActionsBlocked(workspace);
  return (
    <div className="stack plan-review">
      <WorkspaceNotices workspace={workspace} />
      <section className="panel" aria-labelledby="plan-review-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">PRODUCTION PLAN</p>
            <h2 id="plan-review-title" tabIndex={-1}>
              Suppliers &amp; sequence
            </h2>
          </div>
          {plan && (
            <Badge
              value={
                plan.intentVersion !== order?.intentVersion
                  ? "stale"
                  : plan.status
              }
            />
          )}
        </div>
        {plan ? (
          <>
            <dl className="plan-metrics">
              <div>
                <dt>Total production cost</dt>
                <dd>{money(plan.totalCost, plan.currency)}</dd>
              </div>
              <div>
                <dt>Estimated completion</dt>
                <dd>{dateLabel(plan.estimatedCompletion)}</dd>
              </div>
              <div>
                <dt>Solver risk score</dt>
                <dd>{Math.round(plan.riskScore * 100)}%</dd>
              </div>
            </dl>
            {plan.intentVersion !== order?.intentVersion && (
              <p className="inline-warning inset">
                This plan belongs to earlier requirements. It cannot be
                approved.
              </p>
            )}
            {plan.status === "UNSAT" && (
              <div className="unsat-panel">
                <h3>Requirements that need attention</h3>
                {plan.constraintResults
                  .filter((result) => !result.satisfied)
                  .map((result) => (
                    <p key={result.constraintId}>{result.explanation}</p>
                  ))}
                {plan.unsatRelaxations.map((relaxation) => {
                  const constraint = order?.intent?.hardConstraints.find(
                    (item) => item.constraintId === relaxation.constraintId,
                  );
                  const draft = relaxationDraft(
                    constraint?.field ?? relaxation.constraintId,
                    relaxation.proposedValue,
                    order?.intent?.currency ?? plan.currency,
                  );
                  return (
                    <div key={relaxation.constraintId}>
                      <strong>{relaxation.explanation}</strong>
                      <p>
                        Proposed value: {displayValue(relaxation.proposedValue)}
                      </p>
                      {draft ? (
                        <button
                          type="button"
                          className="text-button"
                          disabled={!workspace.canSubmitMessage}
                          onClick={() => onSuggest(draft)}
                        >
                          Add change to draft for review
                        </button>
                      ) : (
                        <p className="muted small">
                          Describe this change in your own words; there is no
                          supported quick change for this constraint.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {plan.constraintResults.length > 0 && (
              <details className="constraint-checks inset">
                <summary>
                  Solver checks · {plan.constraintResults.length}
                </summary>
                <ul>
                  {plan.constraintResults.map((result) => (
                    <li key={result.constraintId}>
                      <span
                        className={
                          result.satisfied ? "check-good" : "check-bad"
                        }
                      >
                        {result.satisfied ? "Satisfied" : "Not satisfied"}
                      </span>
                      <span>{result.explanation}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {(comparison.cost !== undefined ||
              comparison.hours != null ||
              comparison.deadlinePreserved !== null) && (
              <div className="recovery-summary">
                <strong>Replacement plan comparison</strong>
                {comparison.cost !== undefined && (
                  <span>
                    Cost {comparison.cost >= 0 ? "+" : ""}
                    {money(comparison.cost, plan.currency)}
                  </span>
                )}
                <span>
                  {comparison.hours != null
                    ? `Completion ${comparison.hours >= 0 ? "+" : ""}${comparison.hours.toFixed(1)} hours`
                    : comparison.deadlinePreserved === null
                      ? "Completion change not provided"
                      : comparison.deadlinePreserved
                        ? "Deadline preserved by server"
                        : "Deadline changed"}
                </span>
              </div>
            )}
          </>
        ) : (
          <Empty
            title={
              workspace.loading
                ? "Loading the saved plan"
                : workspace.orderId && !order
                  ? "Saved plan unavailable"
                  : "No solver plan yet"
            }
          >
            {order
              ? "Send or clarify the brief in the workspace. Confirmed progress appears in Activity."
              : workspace.orderId
                ? "The project could not be read. Retry the project before making changes."
                : "Start with a production brief to request suppliers, quotes and a solver-validated plan."}
          </Empty>
        )}
        {workspace.canSubmitMessage && (
          <div className="plan-footer">
            <p>
              Need to change the requirements? A correction runs the solver
              again.
            </p>
            <button type="button" className="secondary" onClick={onCompose}>
              Edit the brief
            </button>
          </div>
        )}
      </section>
      {order && (
        <>
          {workspace.capabilities.hasUncompiledContexts && (
            <p className="notice notice-warning">
              Attached context has not been included in the requirements. Send
              an update in the workspace before approval.
            </p>
          )}
          <ExecutionView
            order={order}
            marketplace={marketplace}
            busy={workspace.operation === "approval"}
            actionsBlocked={actionsBlocked}
            blockedReason={workspace.capabilities.reason}
            demoMode={
              workspace.demoMode &&
              !workspace.configLoading &&
              !workspace.configError
            }
            resetting={workspace.operation === "reset"}
            onApprove={() => void workspace.approve()}
            onOffline={(id) => void workspace.offline(id)}
            onReset={() => void workspace.resetDemo()}
            events={events}
          />
        </>
      )}
    </div>
  );
}

export function PlanReview({
  workspace,
  onCompose,
  onSuggest,
  onMerchant,
}: {
  workspace: Workspace;
  onCompose: () => void;
  onSuggest: (value: string) => void;
  onMerchant: (id: string) => void;
}) {
  const { order, marketplace, previousPlan, events } = workspace;
  const plan = order?.activePlan ?? null;
  const [actionsOpen, setActionsOpen] = useState(false);
  const [selection, setSelection] = useState<PlanSelection | null>(null);
  const selected = resolveSelectedNode(plan, previousPlan, selection);
  const offline = useMemo(
    () =>
      new Set([
        ...events
          .filter((event) => event.eventType === "supplier.offline")
          .flatMap((event) => (event.merchantId ? [event.merchantId] : [])),
        ...(marketplace?.merchants
          .filter((merchant) => merchant.status === "offline")
          .map((merchant) => merchant.merchantId) ?? []),
      ]),
    [events, marketplace],
  );
  const details =
    selected && selection && order ? (
      <GraphDetailPanel onClose={() => setSelection(null)}>
        <NodeDetail
          node={selected}
          order={order}
          currency={selection.currency}
          marketplace={marketplace}
          selection={selection}
          onMerchant={(id) => {
            setSelection(null);
            onMerchant(id);
          }}
        />
      </GraphDetailPanel>
    ) : null;
  return (
    <section
      className="plan-actions-dark canvas-plan"
      aria-label="Production flow chart"
    >
      <div className="canvas-heading">
        <p className="eyebrow">PRODUCTION PLAN</p>
        <h1>Plan &amp; actions</h1>
        <p>
          {plan?.nodes.length
            ? `${money(plan.totalCost, plan.currency)} · ${dateLabel(plan.estimatedCompletion)}`
            : "Your production flow"}
        </p>
        {plan && (
          <Badge
            value={
              plan.intentVersion !== order?.intentVersion
                ? "stale"
                : plan.status
            }
          />
        )}
      </div>
      <div className="canvas-actions">
        <button type="button" className="secondary" onClick={onCompose}>
          View brief
        </button>
        <button
          type="button"
          className="secondary"
          aria-expanded={actionsOpen}
          onClick={() => {
            setSelection(null);
            setActionsOpen(!actionsOpen);
          }}
        >
          Plan details &amp; actions
        </button>
      </div>
      {plan?.nodes.length ? (
        <PlanGraph
          key={plan.planId}
          plan={plan}
          previousPlan={previousPlan}
          merchants={marketplace?.merchants ?? []}
          candidates={order?.candidates ?? []}
          offlineMerchants={offline}
          onSelect={() => setActionsOpen(false)}
          onSelectContext={setSelection}
          overlay={details}
        />
      ) : (
        <div className="decision-plan-graph">
          <div className="graph canvas-empty">
            <div className="canvas-empty-message">
              <Empty
                title={
                  workspace.loading
                    ? "Loading the saved plan"
                    : workspace.orderId && !order
                      ? "Saved plan unavailable"
                      : plan
                        ? "No feasible production plan"
                        : "No production plan yet"
                }
              >
                {plan
                  ? "Review solver conflicts and proposed changes to create a connected plan."
                  : "Open a project or send a brief to create your production flow."}
              </Empty>
              <button
                type="button"
                className="secondary"
                onClick={() => setActionsOpen(true)}
              >
                Review plan details
              </button>
              {workspace.orderId && !order && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void workspace.refresh()}
                >
                  Retry project
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {actionsOpen && (
        <div className="canvas-actions-inspector">
          <GraphDetailPanel
            title="Plan details & actions"
            onClose={() => setActionsOpen(false)}
          >
            <PlanActionsPanel
              workspace={workspace}
              onCompose={onCompose}
              onSuggest={onSuggest}
              onMerchant={onMerchant}
            />
          </GraphDetailPanel>
        </div>
      )}
    </section>
  );
}
