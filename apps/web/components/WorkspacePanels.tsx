"use client";

import type {
  CanonicalClaim,
  MarketplaceSnapshot,
  MerchantTwinSummary,
  MoleculeEvent,
  OrderSessionSnapshot,
  ProductionPlan,
} from "@molecule/contracts";
import { useState } from "react";
import {
  dateLabel,
  displayValue,
  humanize,
  money,
  safeHref,
  supplierAdminUrl,
} from "../lib/workspace";

export function Badge({ value }: { value: string }) {
  const good = [
    "active",
    "online",
    "ready",
    "VALID",
    "CAN_ACCEPT",
    "SUCCEEDED",
    "COMPLETED",
  ].includes(value);
  const bad = [
    "offline",
    "conflicted",
    "quarantined",
    "FAILED",
    "DECLINE",
    "ERROR",
    "UNSAT",
  ].includes(value);
  return (
    <span
      className={`badge ${good ? "badge-good" : bad ? "badge-bad" : "badge-neutral"}`}
    >
      {humanize(value)}
    </span>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-symbol" aria-hidden="true">
        ◇
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function EventList({
  events,
  limit = 20,
}: {
  events: MoleculeEvent[];
  limit?: number;
}) {
  if (!events.length)
    return (
      <Empty title="No recorded events yet">
        Confirmed server activity will appear here.
      </Empty>
    );
  return (
    <ol className="event-list">
      {events
        .slice(-limit)
        .reverse()
        .map((event) => (
          <li key={event.eventId}>
            <span
              className={`event-dot severity-${event.severity.toLowerCase()}`}
            />
            <div>
              <strong>{humanize(event.eventType)}</strong>
              <small>
                {event.source}
                {event.merchantId ? ` · ${event.merchantId}` : ""}
              </small>
            </div>
            <time dateTime={event.ts}>{dateLabel(event.ts, true)}</time>
          </li>
        ))}
    </ol>
  );
}

export function ClaimTable({ claims }: { claims: CanonicalClaim[] }) {
  if (!claims.length)
    return (
      <p className="muted inset">
        No source claims returned. Operational facts remain unknown.
      </p>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Fact / value</th>
            <th>Source</th>
            <th>Resolution</th>
            <th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((claim) => (
            <tr key={claim.claimId}>
              <td>
                <strong>{humanize(claim.field)}</strong>
                <span>
                  {displayValue(claim.normalizedValue)} {claim.normalizedUnit}
                </span>
                <details>
                  <summary>Evidence &amp; identity</summary>
                  <p>{claim.evidenceText ?? "No evidence excerpt returned."}</p>
                  <code>{claim.claimId}</code>
                  <small>
                    Observed {dateLabel(claim.observedAt, true)} · ingested{" "}
                    {dateLabel(claim.ingestedAt, true)}
                  </small>
                </details>
              </td>
              <td>
                {humanize(claim.source.kind)}
                <small>{claim.source.reference}</small>
              </td>
              <td>
                <Badge value={claim.resolutionStatus} />
              </td>
              <td>
                {Math.round(claim.extractionConfidence * 100)}%
                <small>
                  Authority {Math.round(claim.sourceAuthority * 100)}%
                </small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MerchantDetail({
  merchant,
}: {
  merchant: MerchantTwinSummary;
}) {
  const [tab, setTab] = useState<"capabilities" | "claims" | "memory">(
    "capabilities",
  );
  return (
    <section className="merchant-detail">
      <div className="section-heading">
        <div>
          <p className="eyebrow">MERCHANT TWIN</p>
          <h2>{merchant.name}</h2>
          <small className="muted">{merchant.merchantId}</small>
        </div>
        <Badge value={merchant.status} />
      </div>
      <div className="tabs" role="group" aria-label="Merchant detail sections">
        {(["capabilities", "claims", "memory"] as const).map((name) => (
          <button
            type="button"
            key={name}
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            {name === "memory" ? "Memory & documents" : humanize(name)}
          </button>
        ))}
      </div>
      {tab === "capabilities" && (
        <div className="capability-list">
          {merchant.capabilities.length ? (
            merchant.capabilities.map((candidate) => {
              const item = candidate.capability;
              return (
                <article key={candidate.capabilityId} className="capability">
                  <div className="section-heading">
                    <h3>{item.name}</h3>
                    <span className="eyebrow">{humanize(item.kind)}</span>
                  </div>
                  <p>{item.description}</p>
                  <dl className="detail-grid">
                    <div>
                      <dt>Unit price</dt>
                      <dd>
                        {money(item.pricing.unitPrice, item.pricing.currency)}
                      </dd>
                    </div>
                    <div>
                      <dt>Setup</dt>
                      <dd>
                        {money(item.pricing.setupFee, item.pricing.currency)}
                      </dd>
                    </div>
                    <div>
                      <dt>Lead time</dt>
                      <dd>
                        {item.leadTime.min}–{item.leadTime.max}{" "}
                        {humanize(item.leadTime.unit)}
                      </dd>
                    </div>
                    <div>
                      <dt>Available capacity</dt>
                      <dd>
                        {item.capacity.available ?? "Unknown"}
                        {item.capacity.period
                          ? ` / ${item.capacity.period}`
                          : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Quantity range</dt>
                      <dd>
                        {item.quantity.min}–{item.quantity.max}{" "}
                        {item.quantity.unit}
                      </dd>
                    </div>
                    <div>
                      <dt>Capacity checked</dt>
                      <dd>{dateLabel(item.capacity.asOf, true)}</dd>
                    </div>
                  </dl>
                  <div className="port-row">
                    <span>Inputs</span>
                    <p>
                      {item.accepts.map((port) => port.name).join(", ") ||
                        "None specified"}
                    </p>
                    <span>Outputs</span>
                    <p>
                      {item.produces.map((port) => port.name).join(", ") ||
                        "None specified"}
                    </p>
                  </div>
                  {candidate.blockedReasons.map((reason) => (
                    <p className="inline-warning" key={reason}>
                      {reason}
                    </p>
                  ))}
                  <details>
                    <summary>Rules, risk &amp; source references</summary>
                    <ul>
                      {item.hardRules.map((rule) => (
                        <li key={rule.constraintId}>
                          {rule.description ??
                            `${rule.field} ${rule.operator} ${displayValue(rule.value)}`}
                        </li>
                      ))}
                    </ul>
                    <p>
                      {candidate.risk
                        ? `${candidate.risk.sampleCount} risk samples · ${candidate.risk.confidence} confidence · 95th percentile ${candidate.risk.p95Hours ?? "unknown"} hours`
                        : "Risk sample data not returned."}
                    </p>
                    <p className="muted">
                      Source claim IDs:{" "}
                      {item.sourceClaimIds.join(", ") || "None returned"}
                    </p>
                  </details>
                </article>
              );
            })
          ) : (
            <Empty title="No capabilities returned" />
          )}
        </div>
      )}
      {tab === "claims" && <ClaimTable claims={merchant.claims} />}
      {tab === "memory" && (
        <div className="inset">
          <h3>Sanitized merchant memory</h3>
          {merchant.memories.length ? (
            merchant.memories.map((memory) => (
              <blockquote className="memory" key={memory.memoryId}>
                <p>{memory.note}</p>
                <footer>
                  {dateLabel(memory.recordedAt, true)} ·{" "}
                  {memory.sourceThreadId ?? "Source thread not returned"}
                </footer>
              </blockquote>
            ))
          ) : (
            <p className="muted">No merchant memory returned.</p>
          )}
          <h3>Policies</h3>
          {merchant.policies.length ? (
            <ul className="plain-list">
              {merchant.policies.map((policy, index) => (
                <li key={`${index}:${policy}`}>{policy}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No policies returned.</p>
          )}
          <h3>Documents</h3>
          {merchant.documents.length ? (
            <ul className="document-list">
              {merchant.documents.map((document) => (
                <li key={document.documentId}>
                  <span>{document.name}</span>
                  <Badge value={document.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No documents returned.</p>
          )}
        </div>
      )}
    </section>
  );
}

export function MerchantsView({
  marketplace,
  selectedMerchantId,
  onSelect,
}: {
  marketplace: MarketplaceSnapshot | null;
  selectedMerchantId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const merchants = marketplace?.merchants ?? [];
  const filtered = merchants.filter((merchant) =>
    `${merchant.name} ${merchant.capabilities.map((item) => item.capability.name).join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const selected =
    merchants.find((item) => item.merchantId === selectedMerchantId) ??
    filtered[0];
  return (
    <div className="directory-layout">
      <section className="panel merchant-directory">
        <div className="section-heading">
          <h2>Merchant network</h2>
          <span className="count">
            {marketplace ? merchants.length : "Unavailable"}
          </span>
        </div>
        <label className="search-field">
          <span className="sr-only">Search merchants or capabilities</span>
          <input
            placeholder="Search merchants or capabilities"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="merchant-list">
          {filtered.map((merchant) => (
            <button
              type="button"
              key={merchant.merchantId}
              className={
                selected?.merchantId === merchant.merchantId
                  ? "merchant-row selected"
                  : "merchant-row"
              }
              onClick={() => onSelect(merchant.merchantId)}
              aria-pressed={selected?.merchantId === merchant.merchantId}
            >
              <span className="merchant-avatar">
                {merchant.name.slice(0, 2).toUpperCase()}
              </span>
              <span>
                <strong>{merchant.name}</strong>
                <small>
                  {merchant.capabilities.length} capabilities ·{" "}
                  {merchant.claims.length} claims
                </small>
              </span>
              <span
                className={`status-dot ${merchant.status}`}
                aria-label={merchant.status}
              />
            </button>
          ))}
        </div>
        {!filtered.length && (
          <Empty
            title={
              query ? "No matching merchants" : "Merchant data unavailable"
            }
          >
            {query
              ? "Try a different name or capability."
              : "Refresh the marketplace to load the server read model."}
          </Empty>
        )}
      </section>
      <div className="panel">
        {selected ? (
          <MerchantDetail key={selected.merchantId} merchant={selected} />
        ) : (
          <Empty title="Select a merchant">
            Inspect capabilities, source claims and operational memory.
          </Empty>
        )}
      </div>
    </div>
  );
}

export function RealityView({
  marketplace,
}: {
  marketplace: MarketplaceSnapshot | null;
}) {
  const [filter, setFilter] = useState("all");
  const merchants = marketplace?.merchants ?? [];
  const claims = merchants.flatMap((merchant) => merchant.claims);
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">SOURCE OF TRUTH</p>
          <h2>Evidence before assumptions</h2>
          <p className="muted">
            Conflicted, quarantined and unknown facts stay unresolved until the
            server resolves them.
          </p>
        </div>
        <label className="filter-label">
          Resolution
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All facts ({claims.length})</option>
            {[
              "active",
              "conflicted",
              "unknown",
              "quarantined",
              "superseded",
            ].map((status) => (
              <option key={status} value={status}>
                {humanize(status)} (
                {
                  claims.filter((claim) => claim.resolutionStatus === status)
                    .length
                }
                )
              </option>
            ))}
          </select>
        </label>
      </div>
      {merchants
        .filter((merchant) =>
          merchant.claims.some(
            (claim) => filter === "all" || claim.resolutionStatus === filter,
          ),
        )
        .map((merchant) => (
          <section className="reality-merchant" key={merchant.merchantId}>
            <h3>
              {merchant.name}
              <Badge value={merchant.status} />
            </h3>
            <ClaimTable
              claims={merchant.claims.filter(
                (claim) =>
                  filter === "all" || claim.resolutionStatus === filter,
              )}
            />
          </section>
        ))}
      {!claims.some(
        (claim) => filter === "all" || claim.resolutionStatus === filter,
      ) && (
        <Empty title="No facts in this view">
          Choose another resolution filter or refresh the marketplace.
        </Empty>
      )}
    </section>
  );
}

export function OperationsView({
  marketplace,
}: {
  marketplace: MarketplaceSnapshot | null;
}) {
  if (!marketplace)
    return (
      <section className="panel">
        <Empty title="Operations data unavailable">
          Refresh the marketplace to load persisted metrics and provider status.
        </Empty>
      </section>
    );
  const metrics = marketplace.metrics;
  const values = [
    ["Projects", metrics.orderCount],
    ["Validated plans", metrics.validatedPlanCount],
    ["Committed orders", metrics.committedOrderCount],
    ["Reservations", metrics.reservationCount],
    ["Conflicts", metrics.conflictCount],
    ["Recoveries completed", metrics.recoveriesCompleted],
  ] as const;
  const max = Math.max(1, ...metrics.eventCounts.map((entry) => entry.count));
  return (
    <div className="stack">
      <div className="metrics-strip">
        {values.map(([label, value]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{value.toLocaleString("en-CA")}</strong>
          </article>
        ))}
      </div>
      <div className="two-column">
        <section className="panel">
          <div className="section-heading">
            <h2>Provider health</h2>
            <small>Server reported</small>
          </div>
          <div className="provider-list">
            {marketplace.providers.map((provider) => (
              <article key={provider.name}>
                <div>
                  <strong>{humanize(provider.name)}</strong>
                  <span className="mode-tag">{humanize(provider.mode)}</span>
                  <Badge value={provider.status} />
                </div>
                <p>{provider.detail}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>Recorded activity</h2>
            <span className="count">{metrics.eventCount} events</span>
          </div>
          <div className="event-bars">
            {metrics.eventCounts.map((entry) => (
              <div key={entry.eventType}>
                <span>{humanize(entry.eventType)}</span>
                <strong>{entry.count}</strong>
                <div className="bar-track">
                  <i style={{ width: `${(entry.count / max) * 100}%` }} />
                </div>
              </div>
            ))}
            {!metrics.eventCounts.length && (
              <Empty title="No activity recorded" />
            )}
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>Persisted event ledger</h2>
          <small>As of {dateLabel(marketplace.generatedAt, true)}</small>
        </div>
        <EventList events={marketplace.recentEvents} limit={40} />
      </section>
    </div>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string | undefined;
  children: React.ReactNode;
}) {
  const safe = safeHref(href);
  return safe ? (
    <a
      className="external-link"
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children} ↗
    </a>
  ) : null;
}

export function ExecutionView({
  order,
  marketplace,
  busy,
  demoMode,
  onApprove,
  onOffline,
}: {
  order: OrderSessionSnapshot | null;
  marketplace: MarketplaceSnapshot | null;
  busy: boolean;
  demoMode: boolean;
  onApprove: () => void;
  onOffline: (merchantId: string) => void;
}) {
  const plan = order?.activePlan;
  const receipt = order?.executionReceipt;
  const approve =
    plan?.status === "VALID" &&
    plan.intentVersion === order?.intentVersion &&
    order?.state === "AWAITING_APPROVAL";
  const selected = [
    ...new Set(plan?.nodes.map((node) => node.merchantId) ?? []),
  ];
  return (
    <div className="stack">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">COMMERCE EXECUTION</p>
            <h2>
              {receipt ? "Commerce receipts" : "Review before committing"}
            </h2>
          </div>
          {order && <Badge value={order.state} />}
        </div>
        <div className="inset">
          {plan ? (
            <>
              <dl className="detail-grid">
                <div>
                  <dt>Plan total</dt>
                  <dd>{money(plan.totalCost, plan.currency)}</dd>
                </div>
                <div>
                  <dt>Expected completion</dt>
                  <dd>{dateLabel(plan.estimatedCompletion)}</dd>
                </div>
                <div>
                  <dt>Intent version</dt>
                  <dd>{plan.intentVersion}</dd>
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
              <p className="muted">
                Approval commits the current plan&apos;s commerce actions.
                Provider receipts below are the execution record.
              </p>
              <button
                className="primary"
                type="button"
                disabled={!approve || busy}
                onClick={onApprove}
              >
                {busy
                  ? "Action in progress…"
                  : approve
                    ? `Approve ${money(plan.totalCost, plan.currency)} plan`
                    : receipt
                      ? "See execution status below"
                      : "Awaiting a current validated plan"}
              </button>
            </>
          ) : (
            <Empty title="No plan to approve">
              Describe the outcome in Command Center, then review the
              solver&apos;s plan here.
            </Empty>
          )}
        </div>
        {receipt && (
          <div className="receipt">
            <div className="receipt-heading">
              <h3>Receipt for intent version {receipt.intentVersion}</h3>
              <code>{receipt.planId}</code>
            </div>
            {receipt.planId !== plan?.planId && (
              <p className="inline-warning">
                This receipt belongs to a previous plan. It does not confirm the
                current plan.
              </p>
            )}
            <div className="receipt-links">
              <ExternalLink href={receipt.compositeProduct?.adminUrl}>
                Product admin
              </ExternalLink>
              <ExternalLink href={receipt.compositeProduct?.storefrontUrl}>
                Storefront
              </ExternalLink>
              <ExternalLink href={receipt.customerOrder?.checkoutUrl}>
                Customer checkout
              </ExternalLink>
            </div>
            {receipt.customerOrder && (
              <p className="muted">
                Customer reference:{" "}
                {receipt.customerOrder.orderGid ??
                  receipt.customerOrder.draftOrderGid ??
                  "Not returned"}
              </p>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Status</th>
                    <th>Provider reference / error</th>
                  </tr>
                </thead>
                <tbody>
                  {receipt.actions.map((action) => (
                    <tr key={action.actionKey}>
                      <td>
                        <strong>{humanize(action.kind)}</strong>
                        <small>{action.actionKey}</small>
                      </td>
                      <td>
                        <Badge value={action.status} />
                      </td>
                      <td>
                        {action.errorCode ??
                          action.providerRef ??
                          "Not returned"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Supplier jobs</h3>
            <ul className="document-list">
              {receipt.supplierJobs.map((job) => (
                <li key={`${job.nodeId}:${job.draftOrderGid}`}>
                  <span>
                    {marketplace?.merchants.find(
                      (merchant) => merchant.merchantId === job.merchantId,
                    )?.name ?? job.merchantId}
                    <small>{job.draftOrderGid}</small>
                  </span>
                  <ExternalLink
                    href={supplierAdminUrl(job.storeDomain, job.draftOrderGid)}
                  >
                    Supplier admin
                  </ExternalLink>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">RESILIENCE LAB</p>
            <h2>Supplier recovery</h2>
          </div>
          <span className="mode-tag">
            {demoMode ? "Demo enabled by server" : "Demo controls unavailable"}
          </span>
        </div>
        <div className="inset">
          <p>
            Take a selected supplier offline to request a replacement plan. The
            solver must validate the replacement; cost or deadline changes may
            need your approval.
          </p>
          {demoMode && selected.length ? (
            <div className="recovery-buttons">
              {selected.map((id) => (
                <button
                  className="danger-outline"
                  key={id}
                  type="button"
                  disabled={
                    busy ||
                    !["AWAITING_APPROVAL", "COMPLETED"].includes(
                      order?.state ?? "",
                    ) ||
                    marketplace?.merchants.find(
                      (merchant) => merchant.merchantId === id,
                    )?.status === "offline"
                  }
                  onClick={() => onOffline(id)}
                >
                  Take{" "}
                  {marketplace?.merchants.find(
                    (merchant) => merchant.merchantId === id,
                  )?.name ?? id}{" "}
                  offline
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">
              {demoMode
                ? "A selected production plan is required."
                : "The server must enable demo mode to use supplier-offline controls."}
            </p>
          )}
          <p className="muted small">
            Inventory, price, lead-time and conflicting-document simulations are
            not enabled by this server contract.
          </p>
        </div>
      </section>
    </div>
  );
}

export function NodeDetail({
  node,
  order,
  currency,
  marketplace,
  onMerchant,
}: {
  node: ProductionPlan["nodes"][number];
  order: OrderSessionSnapshot;
  currency: ProductionPlan["currency"] | undefined;
  marketplace: MarketplaceSnapshot | null;
  onMerchant: (id: string) => void;
}) {
  const merchant = marketplace?.merchants.find(
    (item) => item.merchantId === node.merchantId,
  );
  const candidate =
    order.candidates.find(
      (item) =>
        item.capabilityId === node.capabilityId &&
        item.merchantId === node.merchantId,
    ) ??
    merchant?.capabilities.find(
      (item) => item.capabilityId === node.capabilityId,
    );
  const quote = order.quotes.find(
    (item) =>
      item.capabilityId === node.capabilityId &&
      item.merchantId === node.merchantId,
  );
  const claims =
    merchant?.claims.filter((claim) =>
      candidate?.capability.sourceClaimIds.includes(claim.claimId),
    ) ?? [];
  return (
    <>
      <p className="eyebrow">{humanize(node.kind)}</p>
      <h2>{merchant?.name ?? node.merchantId}</h2>
      <p>{candidate?.capability.name ?? node.capabilityId}</p>
      <dl className="detail-grid">
        <div>
          <dt>Node cost</dt>
          <dd>{money(node.totalCost, currency)}</dd>
        </div>
        <div>
          <dt>Quantity</dt>
          <dd>{node.quantity}</dd>
        </div>
        <div>
          <dt>Starts</dt>
          <dd>{dateLabel(node.startsAt, true)}</dd>
        </div>
        <div>
          <dt>Completes</dt>
          <dd>{dateLabel(node.completesAt, true)}</dd>
        </div>
      </dl>
      <h3>Current quote</h3>
      {quote ? (
        <>
          <Badge value={quote.status} />
          <p>{quote.explanation}</p>
          <dl className="detail-grid">
            <div>
              <dt>Unit / setup</dt>
              <dd>
                {money(quote.unitPrice, quote.currency)} /{" "}
                {money(quote.setupFee, quote.currency)}
              </dd>
            </div>
            <div>
              <dt>Confidence</dt>
              <dd>{Math.round(quote.confidence * 100)}%</dd>
            </div>
            <div>
              <dt>Completion estimate</dt>
              <dd>{dateLabel(quote.completionEstimate)}</dd>
            </div>
            <div>
              <dt>Reservation</dt>
              <dd>{quote.reservationId ?? "Not reserved"}</dd>
            </div>
          </dl>
          {quote.requiredChanges.length > 0 && (
            <p>
              Required changes:{" "}
              {quote.requiredChanges
                .map(
                  (change) => `${change.path}: ${displayValue(change.value)}`,
                )
                .join("; ")}
            </p>
          )}
        </>
      ) : (
        <p className="muted">
          No current quote returned for this node. Previous-plan quotes are not
          exposed by the snapshot.
        </p>
      )}
      <h3>Source claims</h3>
      <ClaimTable claims={claims} />
      <button
        type="button"
        className="secondary"
        onClick={() => onMerchant(node.merchantId)}
      >
        Open merchant twin →
      </button>
    </>
  );
}
