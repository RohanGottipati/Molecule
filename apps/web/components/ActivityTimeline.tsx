"use client";

import type { MoleculeEvent } from "@molecule/contracts";
import { useState } from "react";
import {
  activityPayload,
  activityReason,
  activityTitle,
  visibleActivity,
} from "../lib/decisionActivity";
import { dateLabel, humanize } from "../lib/workspace";

export function ActivityTimeline({
  events,
  limit = 20,
}: {
  events: MoleculeEvent[];
  limit?: number;
}) {
  const [mode, setMode] = useState<"decisions" | "all">("decisions");
  const [expanded, setExpanded] = useState(false);
  const visible = visibleActivity(
    events,
    mode,
    expanded ? events.length : limit,
  );
  const available = visibleActivity(events, mode, events.length).length;
  return (
    <div className="activity-timeline">
      <div className="activity-toolbar">
        <div className="tabs" role="group" aria-label="Activity filter">
          <button
            type="button"
            aria-pressed={mode === "decisions"}
            onClick={() => setMode("decisions")}
          >
            Decisions &amp; outcomes
          </button>
          <button
            type="button"
            aria-pressed={mode === "all"}
            onClick={() => setMode("all")}
          >
            All events ({events.length})
          </button>
        </div>
        <p className="muted small">Confirmed server events · newest first</p>
      </div>
      {!visible.length ? (
        <p className="activity-empty">
          {events.length
            ? "No decision events in this view. All events contains the available diagnostics."
            : "No recorded activity yet. Confirmed server actions will appear here."}
        </p>
      ) : (
        <ol className="activity-list">
          {visible.map((event) => (
            <li key={event.eventId}>
              <div
                className={`activity-marker severity-${event.severity.toLowerCase()}`}
                aria-hidden="true"
              />
              <div className="activity-body">
                <div className="activity-heading">
                  <strong>{activityTitle(event)}</strong>
                  <time dateTime={event.ts}>{dateLabel(event.ts, true)}</time>
                </div>
                {activityReason(event) && <p>{activityReason(event)}</p>}
                <details className="activity-diagnostics">
                  <summary>Event details · {humanize(event.source)}</summary>
                  <dl>
                    {[
                      ["Event", event.eventType],
                      ["Event ID", event.eventId],
                      ["Project", event.orderId],
                      ["Plan", event.planId],
                      ["Merchant", event.merchantId],
                      ["Trace", event.traceId],
                      ["Severity", event.severity],
                    ]
                      .filter(([, value]) => value)
                      .map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>
                            <code>{value}</code>
                          </dd>
                        </div>
                      ))}
                  </dl>
                  <p className="muted small">
                    Structured diagnostic fields; private model output is
                    excluded.
                  </p>
                  <pre>{JSON.stringify(activityPayload(event), null, 2)}</pre>
                </details>
              </div>
            </li>
          ))}
        </ol>
      )}
      {available > Math.max(0, limit) && (
        <button
          className="text-button activity-expand"
          type="button"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? "Show recent events"
            : `Show all ${available} available events`}
        </button>
      )}
    </div>
  );
}
