"use client";

import type { ProductionPlan } from "@molecule/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../lib/useWorkspace";
import {
  canEditBrief,
  dateLabel,
  displayValue,
  humanize,
  money,
  planDelta,
  processingStates,
  stateLabels,
  views,
  type WorkspaceView,
} from "../lib/workspace";
import { PlanGraph } from "./PlanGraph";
import { VoiceControl } from "./VoiceControl";
import {
  Badge,
  Empty,
  EventList,
  ExecutionView,
  MerchantsView,
  NodeDetail,
  OperationsView,
  RealityView,
} from "./WorkspacePanels";

const sample =
  "Make 200 premium black onboarding kits by next Friday under CAD 7,000. No leather. Each kit needs a hoodie with logo embroidery, a named engraved bottle, vegan snacks and individual packaging.";
const labels: Record<WorkspaceView, string> = {
  command: "Command Center",
  merchants: "Merchant Twins",
  reality: "Reality & evidence",
  operations: "Operations",
  execution: "Execution",
};
const shortLabels: Record<WorkspaceView, string> = {
  command: "Workspace",
  merchants: "Merchants",
  reality: "Evidence",
  operations: "Operations",
  execution: "Execution",
};
const routeStages = [
  {
    label: "Brief",
    states: ["REQUESTED", "COMPILING_INTENT", "NEEDS_CLARIFICATION"],
  },
  {
    label: "Merchant quotes",
    states: [
      "INTENT_COMPILED",
      "DISCOVERING",
      "CANDIDATES_READY",
      "QUOTING",
      "QUOTED",
      "AT_RISK",
      "RECOVERING",
    ],
  },
  {
    label: "Solver validation",
    states: ["SOLVING", "PLAN_UNSAT", "PLAN_VALIDATED", "AWAITING_APPROVAL"],
  },
  {
    label: "Execution",
    states: [
      "EXECUTING",
      "SKU_CREATED",
      "SUPPLIER_JOBS_CREATED",
      "CUSTOMER_ORDER_CREATED",
      "COMPLETED",
    ],
  },
];
const descriptions: Record<WorkspaceView, string> = {
  command: "From a desired outcome to a company that can deliver it.",
  merchants:
    "Capabilities, operational memory and the evidence behind every merchant.",
  reality: "Trace operational facts back to their sources.",
  operations: "Provider health and activity from the persisted marketplace.",
  execution: "Approve a plan, inspect receipts and recover from change.",
};

function NavIcon({ view }: { view: WorkspaceView }) {
  const paths: Record<WorkspaceView, string> = {
    command: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    merchants: "M12 3l8 5v8l-8 5-8-5V8zM4 8l8 5 8-5M12 13v8",
    reality: "M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h5",
    operations: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    execution: "M5 12l4 4L19 6M3 3h18v18H3z",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="19"
      height="19"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[view]} />
    </svg>
  );
}

function GraphPlaceholder() {
  return (
    <div className="graph-placeholder">
      <svg viewBox="0 0 470 160" aria-hidden="true">
        <g fill="none" stroke="#b7c6bc" strokeWidth="1.5">
          <path d="M115 35h60q15 0 15 15v30h60M115 80h135M115 125h60q15 0 15-15V80M310 80h50" />
          <rect x="25" y="17" width="90" height="36" rx="5" />
          <rect x="25" y="62" width="90" height="36" rx="5" />
          <rect x="25" y="107" width="90" height="36" rx="5" />
          <rect x="250" y="54" width="60" height="52" rx="5" />
          <rect x="360" y="54" width="85" height="52" rx="5" />
        </g>
        <g fill="#657a6c" fontSize="10" textAnchor="middle">
          <text x="70" y="40">
            Component
          </text>
          <text x="70" y="85">
            Component
          </text>
          <text x="70" y="130">
            Component
          </text>
          <text x="280" y="84">
            Assemble
          </text>
          <text x="402" y="84">
            Deliver
          </text>
        </g>
      </svg>
      <h3>Your temporary company starts here</h3>
      <p>
        Describe what should exist. The server discovers merchants, gathers
        quotes and asks the solver to validate a connected production plan.
      </p>
      <small>Illustrative structure · no merchants selected yet</small>
    </div>
  );
}

export function OrderWorkspace({
  initialOrderId,
}: {
  initialOrderId?: string;
}) {
  const workspace = useWorkspace(initialOrderId);
  const { order, marketplace, previousPlan, busy, loading, view, events } =
    workspace;
  const [text, setText] = useState("");
  const [selectedMerchantId, setSelectedMerchantId] = useState<string | null>(
    null,
  );
  const [selectedNode, setSelectedNode] = useState<
    ProductionPlan["nodes"][number] | null
  >(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const previousProjectId = useRef(workspace.orderId);
  const plan = order?.activePlan ?? null;
  const intent = order?.intent;
  const processing = order ? processingStates.includes(order.state) : false;
  const editable = canEditBrief(order);
  const operationLabel =
    workspace.operation === "upload"
      ? "Attaching context…"
      : workspace.operation === "approval"
        ? "Committing the approved plan…"
        : workspace.operation === "recovery"
          ? "Rebuilding around the outage…"
          : processing && order
            ? `${stateLabels[order.state]}…`
            : "Sending your brief…";
  const stalePlan = plan && plan.intentVersion !== order?.intentVersion;
  const delta = planDelta(previousPlan, plan);
  const recovery = [...events]
    .reverse()
    .find(
      (event) =>
        ["recovery.completed", "recovery.approval.required"].includes(
          event.eventType,
        ) && event.payload.replacementPlanId === plan?.planId,
    );
  const costDelta =
    typeof recovery?.payload.costDelta === "number"
      ? recovery.payload.costDelta
      : delta?.cost;
  const offlineMerchants = useMemo(
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
    if (selectedNode) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selectedNode]);
  useEffect(() => {
    setSelectedNode(null);
    if (
      previousProjectId.current &&
      previousProjectId.current !== workspace.orderId
    )
      setText("");
    previousProjectId.current = workspace.orderId;
  }, [workspace.orderId]);

  function suggest(value: string) {
    setText(value);
    textarea.current?.focus();
  }
  function openMerchant(id: string) {
    setSelectedMerchantId(id);
    setSelectedNode(null);
    workspace.navigate("merchants");
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      <aside className="sidebar">
        <a
          href="/"
          className="brand"
          aria-label="Molecule home"
          onClick={(event) => {
            event.preventDefault();
            workspace.navigate("command");
          }}
        >
          <span className="brand-mark">
            m<span>·</span>
          </span>
          <span>
            molecule<small>OPERATING SYSTEM</small>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-monogram">M</span>
          <span>
            Production workspace
            <small>
              {marketplace
                ? `${humanize(marketplace.mode)} environment`
                : "Connecting to marketplace"}
            </small>
          </span>
        </div>
        <p className="nav-caption">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {views.map((item) => (
            <button
              key={item}
              type="button"
              className={view === item ? "nav-item active" : "nav-item"}
              aria-label={labels[item]}
              aria-current={view === item ? "page" : undefined}
              onClick={() => workspace.navigate(item)}
            >
              <NavIcon view={item} />
              <span className="nav-full-label">{labels[item]}</span>
              <span className="nav-short-label" aria-hidden="true">
                {shortLabels[item]}
              </span>
              {view === item && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-project">
          <p className="nav-caption">CURRENT PROJECT</p>
          <span className="project-indicator" />
          <strong>
            {order?.intent?.desiredOutputs[0]?.name ??
              (workspace.orderId
                ? loading
                  ? "Loading project"
                  : order
                    ? "Untitled project"
                    : "Project unavailable"
                : "No active project")}
          </strong>
          <small>
            {workspace.orderId
              ? `#${workspace.orderId.slice(0, 8)}`
              : "Describe your first outcome"}
          </small>
        </div>
        <div className="sidebar-footer">
          <span
            className={`connection-light ${workspace.connection === "connected" ? "online" : ""}`}
          />
          <span>
            {workspace.connection === "connected"
              ? "Event stream connected"
              : workspace.connection === "idle"
                ? "Ready when you are"
                : workspace.connection === "invalid"
                  ? "Event validation warning"
                  : "Event stream reconnecting"}
          </span>
          <small>Feasibility certified by the solver</small>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <strong>{labels[view]}</strong>
          </div>
          <div className="topbar-actions">
            <span className="mode-tag">
              {marketplace
                ? marketplace.mode === "demo"
                  ? "Synthetic demo data"
                  : marketplace.mode === "hybrid"
                    ? "Hybrid · check provider modes"
                    : "Live environment"
                : "Mode unavailable"}
            </span>
            <button
              className="secondary compact"
              type="button"
              disabled={busy}
              onClick={() => {
                workspace.newProject();
                setText("");
                setSelectedNode(null);
              }}
            >
              ＋ New project
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                MOLECULE / {String(views.indexOf(view) + 1).padStart(2, "0")}
              </p>
              <h1>{labels[view]}</h1>
              <p>{descriptions[view]}</p>
            </div>
            <div className="heading-actions">
              <button
                className="text-button"
                type="button"
                disabled={workspace.marketplaceLoading}
                onClick={() => {
                  void workspace.refreshMarketplace();
                  void workspace.refresh();
                  void workspace.refreshConfig();
                }}
              >
                {workspace.marketplaceLoading
                  ? "Refreshing…"
                  : "↻ Refresh data"}
              </button>
              {marketplace && (
                <small>
                  Updated {dateLabel(marketplace.generatedAt, true)}
                </small>
              )}
            </div>
          </div>
          {workspace.marketplaceError && (
            <div className="notice notice-warning" role="status">
              <strong>
                Marketplace unavailable
                {marketplace ? " · showing last received data" : ""}
              </strong>
              <span>{workspace.marketplaceError}</span>
              <button
                type="button"
                disabled={workspace.marketplaceLoading}
                onClick={() => {
                  void workspace.refreshMarketplace();
                  void workspace.refreshConfig();
                }}
              >
                Retry marketplace
              </button>
            </div>
          )}
          {workspace.error && (
            <div className="notice notice-error" role="alert">
              <strong>Action needs attention</strong>
              <span>{workspace.error}</span>
              {workspace.orderId && (
                <button type="button" onClick={() => void workspace.refresh()}>
                  Refresh project status
                </button>
              )}
            </div>
          )}
          {workspace.configError && (
            <div className="notice notice-warning" role="status">
              {workspace.configError}
              <button
                type="button"
                disabled={workspace.configLoading}
                onClick={() => void workspace.refreshConfig()}
              >
                {workspace.configLoading
                  ? "Checking configuration…"
                  : "Retry configuration"}
              </button>
            </div>
          )}
          {workspace.orderId &&
            ["reconnecting", "invalid"].includes(workspace.connection) && (
              <div className="notice notice-warning" role="status">
                <strong>
                  {workspace.connection === "invalid"
                    ? "An event could not be validated."
                    : "Live updates are reconnecting."}
                </strong>
                <span>
                  The project is refreshed every 10 seconds while disconnected.
                  You can also refresh manually.
                </span>
              </div>
            )}

          {view === "command" && (
            <>
              <div className="project-bar">
                <div>
                  <span
                    className={`status-dot ${processing ? "working" : "online"}`}
                  />
                  <strong aria-live="polite">
                    {loading
                      ? "Loading project…"
                      : order
                        ? stateLabels[order.state]
                        : workspace.orderId
                          ? "Project unavailable"
                          : "Ready for a new outcome"}
                  </strong>
                  {workspace.orderId && (
                    <span className="project-id">
                      #{workspace.orderId.slice(0, 8)}
                    </span>
                  )}
                </div>
                <span>
                  {order
                    ? `Intent ${order.intentVersion} · plan generation ${order.planGeneration}`
                    : workspace.orderId
                      ? "Refresh or start a new project"
                      : "No project created until you send a brief"}
                </span>
              </div>
              <ol className="workflow-route" aria-label="Production workflow">
                {routeStages.map((stage, index) => {
                  const active = stage.states.includes(
                    order?.state ?? "REQUESTED",
                  );
                  return (
                    <li
                      key={stage.label}
                      aria-current={active ? "step" : undefined}
                    >
                      <span aria-hidden="true">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      {stage.label}
                    </li>
                  );
                })}
              </ol>
              {(busy || processing) && (
                <div className="activity-line" role="status">
                  <span className="status-dot working" aria-hidden="true" />
                  {operationLabel}
                  <small>
                    Updates appear as the server confirms each step.
                  </small>
                </div>
              )}
              <div className="command-layout">
                <section
                  className="panel conversation-panel"
                  aria-label="Project conversation"
                >
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">01 / THE BRIEF</span>
                      <h2>Describe the outcome</h2>
                    </div>
                    <span className="tiny-symbol" aria-hidden="true">
                      ✳
                    </span>
                  </div>
                  <div
                    className="conversation-log"
                    aria-label="Conversation and confirmed project state"
                  >
                    <div className="assistant-note">
                      <span className="assistant-avatar">m</span>
                      <div>
                        <strong>Your production workspace</strong>
                        <p>
                          You describe something that should exist. Molecule
                          assembles a company to make it.
                        </p>
                        <p className="muted">
                          Include quantities, a deadline, budget and any
                          requirements that must hold.
                        </p>
                      </div>
                    </div>
                    {!order && !workspace.conversation.length && (
                      <button
                        className="example-brief"
                        type="button"
                        onClick={() => suggest(sample)}
                      >
                        <span className="eyebrow">TRY A PRODUCTION BRIEF</span>
                        <strong>200 premium onboarding kits</strong>
                        <span>
                          Black embroidered hoodies, engraved bottles, vegan
                          snacks. Under CAD 7,000.
                        </span>
                        <span className="example-action">Use this brief ↗</span>
                      </button>
                    )}
                    {workspace.conversation.map((entry) => (
                      <article className="conversation-message" key={entry.id}>
                        <small>
                          You ·{" "}
                          {entry.status === "confirmed"
                            ? "server responded"
                            : entry.status === "sending"
                              ? "sending"
                              : "outcome unconfirmed — refresh status"}
                        </small>
                        <p>{entry.text}</p>
                      </article>
                    ))}
                    {intent && (
                      <div className="compiled-brief">
                        <div className="section-heading">
                          <h3>Server-compiled brief</h3>
                          <span className="count">v{order.intentVersion}</span>
                        </div>
                        <dl>
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
                            <dd>
                              {money(
                                intent.budgetMax,
                                intent.currency ?? undefined,
                              )}
                            </dd>
                          </div>
                        </dl>
                        <div className="output-chips">
                          {intent.desiredOutputs.map((output) => (
                            <span key={output.outputId}>{output.name}</span>
                          ))}
                        </div>
                        {intent.hardConstraints.length > 0 && (
                          <details open>
                            <summary>
                              Required constraints ·{" "}
                              {intent.hardConstraints.length}
                            </summary>
                            <ul>
                              {intent.hardConstraints.map((constraint) => (
                                <li key={constraint.constraintId}>
                                  {constraint.description ??
                                    `${humanize(constraint.field)} ${constraint.operator} ${displayValue(constraint.value)}`}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        <small className="muted">
                          Request text is shown for this visit; compiled
                          requirements and events are restored from the server.
                        </small>
                      </div>
                    )}
                    {intent?.ambiguityFlags.map((flag) => (
                      <div className="clarification" key={flag.field}>
                        <strong>{humanize(flag.field)}</strong>
                        <p>{flag.question ?? flag.reason}</p>
                      </div>
                    ))}
                    {order?.lastErrorCode && (
                      <p className="inline-warning">
                        Server reported: {humanize(order.lastErrorCode)}. Review
                        the brief or refresh status.
                      </p>
                    )}
                    {processing && (
                      <div className="progress-note" role="status">
                        <span className="spinner" />
                        {order ? stateLabels[order.state] : "Working"}. Waiting
                        for a confirmed server result.
                      </div>
                    )}
                  </div>
                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const submitted = text;
                      void workspace.send(submitted).then((sent) => {
                        if (sent)
                          setText((current) =>
                            current === submitted ? "" : current,
                          );
                      });
                    }}
                  >
                    <label htmlFor="production-request">
                      {order?.intent
                        ? "Clarify or change the brief"
                        : "What should exist?"}
                    </label>
                    <textarea
                      id="production-request"
                      ref={textarea}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      maxLength={20_000}
                      rows={4}
                      disabled={busy || loading || !editable}
                      aria-describedby="brief-help"
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          (event.metaKey || event.ctrlKey) &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                      placeholder={
                        order?.intent
                          ? "For example: No polyester."
                          : "Quantity, components, deadline, budget…"
                      }
                    />
                    <p id="brief-help" className="composer-help">
                      {editable
                        ? "Include quantity, deadline and budget. Ctrl / ⌘ + Enter to send."
                        : processing
                          ? "Your current plan is being processed. Changes reopen when it is ready for review."
                          : "This brief is closed. Start a new project for another request; execution records stay here."}
                    </p>
                    {order?.intent && editable && (
                      <button
                        type="button"
                        className="suggestion-chip"
                        onClick={() => suggest("No polyester")}
                      >
                        ＋ No polyester
                      </button>
                    )}
                    <div className="composer-tools">
                      <input
                        ref={fileInput}
                        className="sr-only"
                        type="file"
                        accept=".png,.jpg,.jpeg,.pdf,.csv,.txt,.json"
                        aria-label="Upload logo or context"
                        disabled={!order || busy || loading || !editable}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void workspace.upload(file);
                          event.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        className="text-button"
                        disabled={!order || busy || loading || !editable}
                        onClick={() => fileInput.current?.click()}
                        title={
                          order
                            ? "PNG, JPEG, PDF, CSV, text or JSON, up to 10 MB"
                            : "Send your brief to create a project, then attach context"
                        }
                      >
                        {workspace.operation === "upload"
                          ? "Attaching context…"
                          : "＋ Attach context / logo"}
                      </button>
                      <VoiceControl />
                    </div>
                    {workspace.contexts.length > 0 && (
                      <ul className="attachments">
                        {workspace.contexts.map((asset) => (
                          <li key={asset.assetId}>
                            <span>▧ {asset.name ?? asset.assetId}</span>
                            <small>Attached on server</small>
                          </li>
                        ))}
                      </ul>
                    )}
                    {workspace.contexts.length > 0 && editable && (
                      <p className="small muted">
                        Send a message to include attached context in the next
                        compilation.
                      </p>
                    )}
                    <button
                      type="submit"
                      className="primary send-button"
                      disabled={busy || loading || !text.trim() || !editable}
                    >
                      {busy
                        ? operationLabel
                        : !editable
                          ? processing
                            ? "Waiting for the current plan…"
                            : "Brief closed"
                          : order?.intent
                            ? "Send update →"
                            : "Assemble my company →"}
                    </button>
                  </form>
                </section>

                <div className="production-column">
                  <section className="panel production-panel">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">02 / THE COMPANY</span>
                        <h2>Production network</h2>
                      </div>
                      {plan && (
                        <Badge value={stalePlan ? "stale" : plan.status} />
                      )}
                    </div>
                    {plan && (
                      <div className="plan-metrics">
                        <div>
                          <span>Total production cost</span>
                          <strong>
                            {money(plan.totalCost, plan.currency)}
                          </strong>
                          <small>
                            {intent?.budgetMax
                              ? `${money(intent.budgetMax, intent.currency ?? undefined)} budget ceiling`
                              : "Budget not provided"}
                          </small>
                        </div>
                        <div>
                          <span>Expected completion</span>
                          <strong>{dateLabel(plan.estimatedCompletion)}</strong>
                          <small>Server plan estimate</small>
                        </div>
                        <div>
                          <span>Plan risk</span>
                          <strong>{Math.round(plan.riskScore * 100)}%</strong>
                          <small>Solver risk score</small>
                        </div>
                      </div>
                    )}
                    {stalePlan && (
                      <p className="inline-warning inset">
                        This plan belongs to an earlier intent and cannot be
                        approved.
                      </p>
                    )}
                    {plan?.nodes.length ? (
                      <PlanGraph
                        plan={plan}
                        previousPlan={previousPlan}
                        merchants={marketplace?.merchants ?? []}
                        candidates={order?.candidates ?? []}
                        offlineMerchants={offlineMerchants}
                        onSelect={setSelectedNode}
                      />
                    ) : plan?.status === "UNSAT" ? (
                      <Empty title="No feasible production plan">
                        The solver could not satisfy all requirements. Review
                        the conflicts and proposed changes below, then update
                        your brief.
                      </Empty>
                    ) : (
                      <GraphPlaceholder />
                    )}
                    {plan?.status === "UNSAT" && (
                      <div className="unsat-panel">
                        <h3>Requirements that need attention</h3>
                        {plan.constraintResults
                          .filter((result) => !result.satisfied)
                          .map((result) => (
                            <p key={result.constraintId}>
                              {result.explanation}
                            </p>
                          ))}
                        {plan.unsatRelaxations.map((relaxation) => (
                          <div key={relaxation.constraintId}>
                            <strong>{relaxation.explanation}</strong>
                            <p>
                              Proposed value:{" "}
                              {displayValue(relaxation.proposedValue)}
                            </p>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() =>
                                suggest(
                                  `Please revise ${relaxation.constraintId} to ${displayValue(relaxation.proposedValue)}.`,
                                )
                              }
                            >
                              Draft a change for review →
                            </button>
                          </div>
                        ))}
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => textarea.current?.focus()}
                        >
                          Revise the brief
                        </button>
                      </div>
                    )}
                    {costDelta !== undefined && (
                      <div className="recovery-summary">
                        <strong>Replacement plan comparison</strong>
                        <span>
                          Cost {costDelta >= 0 ? "+" : ""}
                          {money(costDelta, plan?.currency)}
                        </span>
                        <span>
                          {delta?.hours !== null && delta?.hours !== undefined
                            ? `Completion ${delta.hours >= 0 ? "+" : ""}${delta.hours.toFixed(1)} hours`
                            : typeof recovery?.payload.deadlinePreserved ===
                                "boolean"
                              ? recovery.payload.deadlinePreserved
                                ? "Deadline preserved by server"
                                : "Deadline changed"
                              : "Completion delta not provided"}
                        </span>
                      </div>
                    )}
                    {plan?.status === "VALID" && (
                      <div className="plan-footer">
                        <span>
                          {plan.nodes.length} production steps ·{" "}
                          {plan.edges.length} material dependencies
                        </span>
                        <button
                          className="primary compact"
                          type="button"
                          onClick={() => workspace.navigate("execution")}
                        >
                          Review execution →
                        </button>
                      </div>
                    )}
                  </section>
                  {order && (
                    <section className="panel">
                      <div className="section-heading">
                        <div>
                          <span className="eyebrow">
                            03 / CONFIRMED ACTIVITY
                          </span>
                          <h2>Company assembly log</h2>
                        </div>
                        <span className="count">Persisted events</span>
                      </div>
                      <EventList events={events} limit={7} />
                    </section>
                  )}
                  {plan?.constraintResults.length ? (
                    <section className="panel constraint-checks">
                      <div className="section-heading">
                        <h2>Solver constraint checks</h2>
                      </div>
                      <ul>
                        {plan.constraintResults.map((result) => (
                          <li key={result.constraintId}>
                            <span
                              className={
                                result.satisfied ? "check-good" : "check-bad"
                              }
                              aria-label={
                                result.satisfied ? "Satisfied" : "Not satisfied"
                              }
                            >
                              {result.satisfied ? "✓" : "!"}
                            </span>
                            <span>{result.explanation}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </div>
              </div>
            </>
          )}
          {view === "merchants" && (
            <MerchantsView
              marketplace={marketplace}
              selectedMerchantId={selectedMerchantId}
              onSelect={setSelectedMerchantId}
            />
          )}
          {view === "reality" && <RealityView marketplace={marketplace} />}
          {view === "operations" && (
            <OperationsView marketplace={marketplace} />
          )}
          {view === "execution" && (
            <ExecutionView
              order={order}
              marketplace={marketplace}
              busy={busy || loading}
              demoMode={workspace.demoMode}
              onApprove={() => void workspace.approve()}
              onOffline={(id) => void workspace.offline(id)}
            />
          )}
          <footer className="workspace-footer">
            <span>Source-backed decisions. Solver-validated plans.</span>
            <span>
              {marketplace?.mode === "demo"
                ? "Demo records are synthetic; no live-provider acceptance claimed."
                : "Provider status and execution receipts are reported by the server."}
            </span>
          </footer>
        </main>
      </div>
      <dialog
        ref={dialog}
        className="node-dialog"
        aria-labelledby="node-dialog-title"
        onClose={() => setSelectedNode(null)}
      >
        <div className="dialog-toolbar">
          <span id="node-dialog-title" className="eyebrow">
            QUOTE &amp; PROVENANCE
          </span>
          <button
            type="button"
            className="secondary compact"
            onClick={() => setSelectedNode(null)}
            aria-label="Close merchant detail"
          >
            Close ×
          </button>
        </div>
        {selectedNode && order && (
          <NodeDetail
            node={selectedNode}
            order={order}
            currency={
              plan?.nodes.some((node) => node.nodeId === selectedNode.nodeId)
                ? plan.currency
                : previousPlan?.currency
            }
            marketplace={marketplace}
            onMerchant={openMerchant}
          />
        )}
      </dialog>
    </div>
  );
}
