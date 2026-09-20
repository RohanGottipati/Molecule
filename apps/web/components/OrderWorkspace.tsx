"use client";

import type { ProductionPlan } from "@molecule/contracts";
import type { FormEvent, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../lib/useWorkspace";
import {
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
import {
  PlanGraph,
  ProductionListView,
  ProductionTimelineView,
} from "./PlanGraph";
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
const descriptions: Record<WorkspaceView, string> = {
  command: "From a desired outcome to a company that can deliver it.",
  merchants:
    "Capabilities, operational memory and the evidence behind every merchant.",
  reality: "Trace operational facts back to their sources.",
  operations: "Provider health and activity from the persisted marketplace.",
  execution: "Approve a plan, inspect receipts and recover from change.",
};

function NavIcon({ view, size = 19 }: { view: WorkspaceView; size?: number }) {
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
      width={size}
      height={size}
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

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 10-2.6 6.4M21 12v-5m0 5h-5" />
    </svg>
  );
}

function CheckShieldIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 2L4 14h6l-1 8 9-12h-6z" />
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

type InputMode = "type" | "voice";

function ModeToggle({
  mode,
  onChange,
}: {
  mode: InputMode;
  onChange: (mode: InputMode) => void;
}) {
  return (
    <div
      className="view-toggle start-mode-toggle"
      role="tablist"
      aria-label="Input mode"
    >
      {(["type", "voice"] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={mode === option}
          onClick={() => onChange(option)}
        >
          {option === "type" ? "Type" : "Voice"}
        </button>
      ))}
    </div>
  );
}

function StartPrompt({
  mode,
  text,
  onChange,
  onSubmit,
  onExample,
  busy,
  textarea,
}: {
  mode: InputMode;
  text: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onExample: () => void;
  busy: boolean;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  if (mode === "voice") return <div className="start-inner" />;

  return (
    <div className="start-inner">
      <h1>What should we build?</h1>
      <form className="start-composer" onSubmit={onSubmit}>
        <textarea
          ref={textarea}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          maxLength={20_000}
          rows={3}
          placeholder="Quantity, components, deadline, budget…"
          autoFocus
        />
        <div className="start-composer-footer">
          <button type="button" className="text-button" onClick={onExample}>
            Try an example →
          </button>
          <button
            type="submit"
            className="primary compact"
            disabled={busy || !text.trim()}
          >
            {busy ? "Assembling…" : "Assemble my company →"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
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
  const [networkView, setNetworkView] = useState<
    "network" | "list" | "timeline"
  >("network");
  const [collapsed, setCollapsed] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>("type");
  const dialog = useRef<HTMLDialogElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const plan = order?.activePlan ?? null;
  const intent = order?.intent;
  const processing = order ? processingStates.includes(order.state) : false;
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
    setNetworkView("network");
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

  const showStart = !workspace.orderId && view === "command";

  return (
    <div className={collapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
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
              aria-current={view === item ? "page" : undefined}
              onClick={() => workspace.navigate(item)}
            >
              <NavIcon view={item} />
              <span>{labels[item]}</span>
              {view === item && <i />}
            </button>
          ))}
          <button
            type="button"
            className="nav-item sidebar-toggle"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <ChevronIcon direction={collapsed ? "right" : "left"} />
            <span>{collapsed ? "Expand" : "Collapse"}</span>
          </button>
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
        {!showStart && (
          <header className="topbar">
            <div className="breadcrumb">
              <span>Workspace</span>
              <span aria-hidden="true">/</span>
              <strong>{labels[view]}</strong>
            </div>
            <div className="topbar-actions">
              <div className="topbar-icons">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Search"
                >
                  <SearchIcon />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Notifications"
                >
                  <BellIcon />
                  <span className="notification-dot" aria-hidden="true" />
                </button>
              </div>
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
                className="primary compact"
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
        )}
        <main
          id="main-content"
          className={showStart ? "main-content start-main" : "main-content"}
        >
          {showStart ? (
            <div className="start-panel">
              <ModeToggle mode={inputMode} onChange={setInputMode} />
              <StartPrompt
                mode={inputMode}
                text={text}
                onChange={setText}
                onExample={() => suggest(sample)}
                busy={busy}
                textarea={textarea}
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
              />
            </div>
          ) : (
            <>
              <div className="page-heading">
                <div className="page-heading-main">
                  <div className="page-icon" aria-hidden="true">
                    <NavIcon view={view} size={22} />
                  </div>
                  <div>
                    <p className="eyebrow">
                      MOLECULE /{" "}
                      {String(views.indexOf(view) + 1).padStart(2, "0")}
                    </p>
                    <h1>{labels[view]}</h1>
                    <p>{descriptions[view]}</p>
                  </div>
                </div>
                <div className="heading-actions">
                  {marketplace && (
                    <span className="updated-label">
                      <ClockIcon />
                      Updated {dateLabel(marketplace.generatedAt, true)}
                    </span>
                  )}
                  <button
                    className="secondary compact"
                    type="button"
                    disabled={workspace.marketplaceLoading}
                    onClick={() => {
                      void workspace.refreshMarketplace();
                      void workspace.refresh();
                    }}
                  >
                    <RefreshIcon />
                    {workspace.marketplaceLoading
                      ? "Refreshing…"
                      : "Refresh data"}
                  </button>
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
                    onClick={() => void workspace.refreshMarketplace()}
                  >
                    Retry marketplace
                  </button>
                </div>
              )}
              {workspace.error && (
                <div className="notice notice-error" role="alert">
                  <strong>Action needs attention</strong>
                  <span>{workspace.error}</span>
                  <button
                    type="button"
                    onClick={() => void workspace.refresh()}
                  >
                    Refresh project status
                  </button>
                </div>
              )}
              {workspace.configError && view === "execution" && (
                <div className="notice notice-warning" role="status">
                  {workspace.configError}
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
                      The project is refreshed every 10 seconds while
                      disconnected. You can also refresh manually.
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
                            <span className="eyebrow">
                              TRY A PRODUCTION BRIEF
                            </span>
                            <strong>200 premium onboarding kits</strong>
                            <span>
                              Black embroidered hoodies, engraved bottles, vegan
                              snacks. Under CAD 7,000.
                            </span>
                            <span className="example-action">
                              Use this brief ↗
                            </span>
                          </button>
                        )}
                        {workspace.conversation.map((entry) => (
                          <article
                            className="conversation-message"
                            key={entry.id}
                          >
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
                              <span className="count">
                                v{order.intentVersion}
                              </span>
                            </div>
                            <dl>
                              <div>
                                <dt>Quantity</dt>
                                <dd>
                                  {intent.quantity ?? "Needs clarification"}
                                </dd>
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
                              {intent.desiredOutputs.map((output, index) => (
                                <span key={`${output.outputId}:${index}`}>
                                  {output.name}
                                </span>
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
                              requirements and events are restored from the
                              server.
                            </small>
                          </div>
                        )}
                        {intent?.ambiguityFlags.map((flag, index) => (
                          <div
                            className="clarification"
                            key={`${flag.field}:${index}`}
                          >
                            <strong>{humanize(flag.field)}</strong>
                            <p>{flag.question ?? flag.reason}</p>
                          </div>
                        ))}
                        {order?.lastErrorCode && (
                          <p className="inline-warning">
                            Server reported: {humanize(order.lastErrorCode)}.
                            Review the brief or refresh status.
                          </p>
                        )}
                        {processing && (
                          <div className="progress-note" role="status">
                            <span className="spinner" />
                            {order ? stateLabels[order.state] : "Working"}.
                            Waiting for a confirmed server result.
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
                          placeholder={
                            order?.intent
                              ? "For example: No polyester."
                              : "Quantity, components, deadline, budget…"
                          }
                        />
                        {order?.intent && (
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
                            disabled={!order || busy || loading}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) void workspace.upload(file);
                              event.target.value = "";
                            }}
                          />
                          <button
                            type="button"
                            className="text-button"
                            disabled={!order || busy || loading}
                            onClick={() => fileInput.current?.click()}
                            title={
                              order
                                ? "PNG, JPEG, PDF, CSV, text or JSON, up to 10 MB"
                                : "Send your brief to create a project, then attach context"
                            }
                          >
                            ＋ Attach context / logo
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
                        {workspace.contexts.length > 0 && (
                          <p className="small muted">
                            Send a message to include attached context in the
                            next compilation.
                          </p>
                        )}
                        <button
                          type="submit"
                          className="primary send-button"
                          disabled={
                            busy || loading || !text.trim() || processing
                          }
                        >
                          {busy
                            ? "Waiting for server…"
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
                          <div className="production-heading-actions">
                            <div
                              className="view-toggle"
                              role="tablist"
                              aria-label="Production network view"
                            >
                              {(["network", "list", "timeline"] as const).map(
                                (option) => (
                                  <button
                                    key={option}
                                    type="button"
                                    role="tab"
                                    aria-selected={networkView === option}
                                    onClick={() => setNetworkView(option)}
                                  >
                                    {option === "network"
                                      ? "Network"
                                      : option === "list"
                                        ? "List"
                                        : "Timeline"}
                                  </button>
                                ),
                              )}
                            </div>
                            {plan && (
                              <Badge
                                value={stalePlan ? "stale" : plan.status}
                              />
                            )}
                          </div>
                        </div>
                        {plan && plan.status === "VALID" && (
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
                              <strong>
                                {dateLabel(plan.estimatedCompletion)}
                              </strong>
                              <small>Server plan estimate</small>
                            </div>
                            <div>
                              <span>Plan risk</span>
                              <strong>
                                {Math.round(plan.riskScore * 100)}%
                              </strong>
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
                        {networkView === "network" ? (
                          plan?.nodes.length ? (
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
                              The solver could not satisfy all requirements.
                              Review the conflicts and proposed changes below,
                              then update your brief.
                            </Empty>
                          ) : (
                            <GraphPlaceholder />
                          )
                        ) : networkView === "list" ? (
                          <ProductionListView
                            plan={plan?.nodes.length ? plan : null}
                            merchants={marketplace?.merchants ?? []}
                            candidates={order?.candidates ?? []}
                            offlineMerchants={offlineMerchants}
                            onSelect={setSelectedNode}
                          />
                        ) : (
                          <ProductionTimelineView
                            plan={plan?.nodes.length ? plan : null}
                            merchants={marketplace?.merchants ?? []}
                            candidates={order?.candidates ?? []}
                            offlineMerchants={offlineMerchants}
                            onSelect={setSelectedNode}
                          />
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
                              {delta?.hours !== null &&
                              delta?.hours !== undefined
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
                                    result.satisfied
                                      ? "check-good"
                                      : "check-bad"
                                  }
                                  aria-label={
                                    result.satisfied
                                      ? "Satisfied"
                                      : "Not satisfied"
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
                <div className="footer-badges">
                  <span>
                    <CheckShieldIcon /> Source-backed decisions
                  </span>
                  <span>
                    <LayersIcon /> Solver-validated plans
                  </span>
                  <span>
                    <BoltIcon />{" "}
                    {plan?.status === "VALID"
                      ? "Ready to execute"
                      : "Ready to assemble"}
                  </span>
                </div>
                <span>
                  {marketplace?.mode === "demo"
                    ? "Demo records are synthetic; no live-provider acceptance claimed."
                    : "Provider status and execution receipts are reported by the server."}
                </span>
              </footer>
            </>
          )}
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
            aria-label="Close quote and provenance details"
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
