import type {
  MarketplaceSnapshot,
  MoleculeEvent,
  OrderSessionSnapshot,
} from "@molecule/contracts";
import {
  canApproveDecision,
  executionAssessment,
} from "../lib/decisionExecution";
import { dateLabel, humanize, money } from "../lib/workspace";
import { Badge } from "./DecisionPrimitives";

export function DecisionApproval({
  order,
  marketplace,
  busy,
  actionsBlocked = false,
  blockedReason,
  events,
  onApprove,
}: {
  order: OrderSessionSnapshot;
  marketplace: MarketplaceSnapshot | null;
  busy: boolean;
  actionsBlocked?: boolean;
  blockedReason?: string | null;
  events: MoleculeEvent[];
  onApprove: () => void;
}) {
  const plan = order.activePlan;
  const status = executionAssessment(order, events);
  const provider = marketplace?.providers.find(
    (item) => item.name === "shopify",
  );
  return (
    <div className="inset decision-approval">
      {plan && (
        <>
          <dl className="decision-summary">
            <div>
              <dt>Plan total</dt>
              <dd>{money(plan.totalCost, plan.currency)}</dd>
            </div>
            <div>
              <dt>Estimated production completion</dt>
              <dd>{dateLabel(plan.estimatedCompletion)}</dd>
            </div>
            <div>
              <dt>Requirements</dt>
              <dd>Version {plan.intentVersion}</dd>
            </div>
            <div>
              <dt>Feasibility</dt>
              <dd>
                {plan.status === "VALID"
                  ? "Validated by solver"
                  : "No feasible plan"}
              </dd>
            </div>
          </dl>
          <p className="decision-plan-reference">
            Affected plan <code>{plan.planId}</code>
          </p>
          {plan.intentVersion !== order.intentVersion && (
            <p className="inline-warning">
              This plan is from earlier requirements. It cannot be approved.
            </p>
          )}
        </>
      )}
      {status === "uncertain" ? (
        <section
          className="decision-handoff"
          aria-label="Execution requires operator review"
        >
          <h3>Commerce outcome needs operator review</h3>
          <p>
            Some provider work may already exist. Review the action statuses and
            resource references below with the provider operator before
            authorizing further work. A new brief or a refresh does not
            reconcile external actions.
          </p>
          <p>
            This view has no provider reconciliation command. Keep pending
            actions intact; do not repeat an uncertain mutation to force a
            result.
          </p>
          <details>
            <summary>Operator handoff identity</summary>
            <dl className="decision-identities">
              <div>
                <dt>Project</dt>
                <dd>
                  <code>{order.orderId}</code>
                </dd>
              </div>
              <div>
                <dt>Active plan</dt>
                <dd>
                  <code>{plan?.planId ?? "Not returned"}</code>
                </dd>
              </div>
              <div>
                <dt>Receipt plan</dt>
                <dd>
                  <code>
                    {order.executionReceipt?.planId ??
                      "No receipt returned; actions remain unconfirmed"}
                  </code>
                </dd>
              </div>
              <div>
                <dt>Trace</dt>
                <dd>
                  <code>{order.traceId}</code>
                </dd>
              </div>
              <div>
                <dt>Reported error</dt>
                <dd>{order.lastErrorCode ?? "No error code returned"}</dd>
              </div>
            </dl>
          </details>
        </section>
      ) : status === "confirmed" ? (
        <p className="decision-status" role="status">
          The server confirmed commerce records and supplier acceptance. This
          does not confirm payment, manufacture or delivery.
        </p>
      ) : status === "executing" ? (
        <p className="decision-status" role="status">
          Approval submitted. The server is executing commerce actions;
          completion is not yet confirmed.
        </p>
      ) : status === "planning" && order.state === "NEEDS_HUMAN" ? (
        <p className="decision-status">
          Planning needs your decision. Review the solver constraints and
          evidence before revising the brief; a proposed relaxation is not a
          feasible plan until the solver validates it.
        </p>
      ) : null}
      {status === "awaiting" && plan && (
        <div className="decision-effects">
          <h3>What approval authorizes</h3>
          <p>
            Create the composite product, customer order record and{" "}
            {plan.nodes.length} supplier job records; reserve capacity and
            request supplier acceptance through the configured adapters.
          </p>
          <ul className="decision-job-preview">
            {plan.nodes.map((node) => (
              <li key={node.nodeId}>
                <span>
                  <strong>
                    {marketplace?.merchants.find(
                      (merchant) => merchant.merchantId === node.merchantId,
                    )?.name ?? node.merchantId}
                  </strong>
                  <small>
                    {humanize(node.kind)} · {node.quantity} units
                  </small>
                </span>
                <span>{money(node.totalCost, plan.currency)}</span>
              </li>
            ))}
          </ul>
          <p className="inline-warning">
            These external changes cannot be undone from this workspace.
            Cancelling or superseding a plan does not undo physical work or
            revoke an invoice already shared.
          </p>
        </div>
      )}
      <div className="decision-provider-mode">
        <strong>
          {provider?.mode === "demo"
            ? "Demo commerce · synthetic records"
            : provider?.mode === "live"
              ? "Live commerce provider configured"
              : "Commerce provider mode unavailable"}
        </strong>
        <p className="muted small">
          {provider?.mode === "demo"
            ? "Demo records do not charge a customer or establish live provider acceptance."
            : "Configuration and a feasible plan do not establish execution success. Only returned server outcomes and receipts do."}
        </p>
        <details>
          <summary>Provider details</summary>
          {provider ? (
            <>
              <Badge value={provider.status} />
              <p>{provider.detail}</p>
            </>
          ) : (
            <p>No provider status returned. Check the marketplace status.</p>
          )}
        </details>
      </div>
      {status !== "confirmed" && status !== "uncertain" && (
        <button
          className="primary decision-approval-cta"
          type="button"
          disabled={!canApproveDecision(order) || busy || actionsBlocked}
          onClick={onApprove}
        >
          {busy || status === "executing"
            ? "Waiting for server confirmation…"
            : canApproveDecision(order) && plan
              ? `Approve & create commerce records · ${money(plan.totalCost, plan.currency)}`
              : "Awaiting a current validated plan"}
        </button>
      )}
      {busy && status !== "executing" && (
        <p className="decision-status" role="status">
          Request in progress. No new execution success is confirmed yet.
        </p>
      )}
      {actionsBlocked && !busy && status === "awaiting" && (
        <p className="decision-status" role="status">
          {blockedReason ??
            "Refresh and review the current project before approving."}
        </p>
      )}
      {!plan && (
        <p className="muted">
          Submit a production brief, then review the solver plan before
          approving commerce actions.
        </p>
      )}
    </div>
  );
}
