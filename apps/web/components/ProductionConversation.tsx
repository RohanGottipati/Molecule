import { useEffect, useRef, useState } from "react";
import type { Workspace } from "../lib/useWorkspace";
import { dateLabel, money } from "../lib/workspace";
import { BriefDetails } from "./BriefDetails";
import { WorkspaceLink } from "./WorkspaceLink";
import {
  historyEmptyMessage,
  messageOutcome,
  savedResultTitle,
} from "./workspacePresentation";

export function ProductionConversation({
  workspace,
}: {
  workspace: Workspace;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const { order, conversation } = workspace;
  const signature = conversation
    .map((entry) => `${entry.id}:${entry.status}:${entry.outcome?.status}`)
    .join("|");
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (follows.current) element.scrollTop = element.scrollHeight;
    else setHasNew(true);
  }, [signature, order?.revision]);
  return (
    <section
      className="production-conversation"
      aria-labelledby="conversation-title"
    >
      <div className="section-heading">
        <h2 id="conversation-title">Brief &amp; results</h2>
      </div>
      <div
        ref={scroll}
        className="conversation-log"
        role="region"
        aria-label="Saved requests and current result"
        tabIndex={0}
        onScroll={() => {
          const element = scroll.current;
          if (!element) return;
          follows.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            48;
          if (follows.current) setHasNew(false);
        }}
      >
        {!conversation.length && (
          <p className="muted">{historyEmptyMessage(workspace)}</p>
        )}
        <ol className="conversation-entries">
          {conversation.map((entry) => (
            <li key={entry.id}>
              <article className="production-message">
                <div className="message-heading">
                  <strong>
                    Your request
                    {entry.source === "desktop"
                      ? " · dock"
                      : entry.source === "web"
                        ? " · web"
                        : ""}
                  </strong>
                  {entry.acceptedAt && (
                    <time dateTime={entry.acceptedAt}>
                      {dateLabel(entry.acceptedAt, true)}
                    </time>
                  )}
                </div>
                <p className="original-request">{entry.text}</p>
                {Boolean(entry.assets?.length) && (
                  <p className="muted small">
                    Context submitted:{" "}
                    {entry.assets
                      ?.map((asset) => asset.name ?? asset.assetId)
                      .join(", ")}
                  </p>
                )}
                <p className="message-outcome">{messageOutcome(entry)}</p>
                {entry.outcome?.reason && (
                  <p className="muted small">{entry.outcome.reason}</p>
                )}
              </article>
            </li>
          ))}
        </ol>
        {workspace.historyNextCursor !== null && (
          <button
            type="button"
            className="secondary"
            disabled={workspace.historyLoading}
            onClick={workspace.loadMoreHistory}
          >
            {workspace.historyLoading ? "Loading…" : "Load more saved requests"}
          </button>
        )}
        {order && (
          <article className="confirmed-result">
            <p className="eyebrow">LATEST RESULT</p>
            <h3>{savedResultTitle(order, workspace.events)}</h3>
            {order.intent && (
              <p>
                {order.intent.desiredOutputs
                  .map((output) => output.name)
                  .join(", ")}
                {order.intent.quantity
                  ? ` · ${order.intent.quantity} units requested`
                  : ""}
              </p>
            )}
            {order.activePlan && (
              <p>
                {order.activePlan.status === "VALID"
                  ? "The solver validated a plan"
                  : "The solver could not satisfy all requirements"}
                {order.activePlan.status === "VALID"
                  ? ` for ${money(order.activePlan.totalCost, order.activePlan.currency)}`
                  : ""}
                .{" "}
                {order.activePlan.intentVersion !== order.intentVersion &&
                  "This plan belongs to earlier requirements."}
              </p>
            )}
            {order.state === "COMPLETED" && (
              <p>
                Commerce outcomes are in the plan and action records. This is
                not a payment or delivery confirmation.
              </p>
            )}
            {order.lastErrorCode && (
              <p className="inline-warning">
                Reported error: {order.lastErrorCode}. Review the recorded
                activity and actions.
              </p>
            )}
            {order.intent?.ambiguityFlags.length ? (
              <section
                className="clarification"
                aria-label="Questions to answer"
              >
                <h3>Details needed</h3>
                <ul>
                  {order.intent.ambiguityFlags.map((flag, index) => (
                    <li key={`${index}:${flag.field}`}>
                      {flag.question ?? flag.reason}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <div className="result-links">
              <WorkspaceLink
                orderId={workspace.orderId}
                view="execution"
                onNavigate={workspace.navigate}
              >
                Plan &amp; actions
              </WorkspaceLink>
              <WorkspaceLink
                orderId={workspace.orderId}
                view="reality"
                onNavigate={workspace.navigate}
              >
                Sources
              </WorkspaceLink>
              <WorkspaceLink
                orderId={workspace.orderId}
                view="operations"
                onNavigate={workspace.navigate}
              >
                Activity
              </WorkspaceLink>
            </div>
          </article>
        )}
      </div>
      {hasNew && (
        <button
          type="button"
          className="follow-latest"
          onClick={() => {
            const element = scroll.current;
            if (element) element.scrollTop = element.scrollHeight;
            follows.current = true;
            setHasNew(false);
          }}
        >
          Follow latest result ↓
        </button>
      )}
      <BriefDetails workspace={workspace} />
    </section>
  );
}
