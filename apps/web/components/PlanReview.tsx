import { useEffect, useMemo, useRef, useState } from "react";
import type { PlanSelection } from "../lib/decisionPlan";
import { relaxationDraft } from "../lib/navigation";
import type { Workspace } from "../lib/useWorkspace";
import { dateLabel, displayValue, money } from "../lib/workspace";
import {
  PlanGraph,
  ProductionListView,
  ProductionTimelineView,
} from "./PlanGraph";
import { Badge, Empty, ExecutionView, NodeDetail } from "./WorkspacePanels";
import {
  decisionActionsBlocked,
  recoveryComparison,
  resolveSelectedNode,
} from "./workspacePresentation";

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
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<"network" | "list" | "timeline">("network");
  const [selection, setSelection] = useState<PlanSelection | null>(null);
  const selected = resolveSelectedNode(plan, previousPlan, selection);
  const comparison = recoveryComparison(previousPlan, plan, events);
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
  useEffect(() => {
    if (selected && !dialog.current?.open) dialog.current?.showModal();
    if (!selected) dialog.current?.close();
  }, [selected]);
  const actionsBlocked = decisionActionsBlocked(workspace);
  return (
    <div className="stack plan-review">
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
            {plan.nodes.length > 0 && (
              <div
                className="view-toggle"
                role="group"
                aria-label="Production network view"
              >
                {(["network", "list", "timeline"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={view === option}
                    onClick={() => setView(option)}
                  >
                    {option === "network"
                      ? "Network"
                      : option === "list"
                        ? "List"
                        : "Timeline"}
                  </button>
                ))}
              </div>
            )}
            {plan.nodes.length ? (
              view === "network" ? (
                <PlanGraph
                  key={plan.planId}
                  plan={plan}
                  previousPlan={previousPlan}
                  merchants={marketplace?.merchants ?? []}
                  candidates={order?.candidates ?? []}
                  offlineMerchants={offline}
                  onSelect={() => undefined}
                  onSelectContext={setSelection}
                />
              ) : (
                (() => {
                  const View =
                    view === "list"
                      ? ProductionListView
                      : ProductionTimelineView;
                  return (
                    <View
                      plan={plan}
                      merchants={marketplace?.merchants ?? []}
                      candidates={order?.candidates ?? []}
                      offlineMerchants={offline}
                      onSelect={(node) =>
                        setSelection({
                          planId: plan.planId,
                          nodeId: node.nodeId,
                          currency: plan.currency,
                          historical: false,
                        })
                      }
                    />
                  );
                })()
              )
            ) : (
              <Empty title="No feasible production plan">
                Review the solver&apos;s conflicts and proposed changes, then
                revise the brief.
              </Empty>
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
      <dialog
        ref={dialog}
        className="node-dialog"
        aria-label="Production step and evidence"
        onClose={() => setSelection(null)}
      >
        <div className="dialog-toolbar">
          <span>Production step</span>
          <button
            type="button"
            className="secondary"
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </div>
        {selected && selection && order && (
          <NodeDetail
            node={selected}
            order={order}
            currency={selection.currency}
            marketplace={marketplace}
            selection={selection}
            onMerchant={(id) => {
              dialog.current?.close();
              onMerchant(id);
            }}
          />
        )}
      </dialog>
    </div>
  );
}
