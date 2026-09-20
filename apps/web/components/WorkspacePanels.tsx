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
import { KnowledgeGraph } from "./KnowledgeGraph";
import { ActivityTimeline } from "./ActivityTimeline";
import { DecisionApproval } from "./DecisionApproval";
import { DecisionReceipts } from "./DecisionReceipts";
import { DecisionRecovery } from "./DecisionRecovery";
import { Badge } from "./DecisionPrimitives";
import { merchantSelection } from "../lib/decisionEvidence";
import { nodeEvidenceContext, type PlanSelection } from "../lib/decisionPlan";
import { kindColorVar } from "../lib/planVisuals";
import { PlanKindIcon } from "./PlanKindIcon";
import {
  dateLabel,
  displayValue,
  humanize,
  money,
  rangeLabel,
  variantAdminUrl,
} from "../lib/workspace";

export { Badge };

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
  return <ActivityTimeline events={events} limit={limit} />;
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
                  {claim.source.checksum && (
                    <small>Source checksum: {claim.source.checksum}</small>
                  )}
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
          <p className="eyebrow">SUPPLIER PROFILE</p>
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
                  <p>{item.description?.replace(/^Synthetic demo: /, "")}</p>
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
                        {rangeLabel(
                          item.leadTime.min,
                          item.leadTime.max,
                          item.leadTime.unit,
                        )}
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
                        {rangeLabel(
                          item.quantity.min,
                          item.quantity.max,
                          item.quantity.unit,
                        )}
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
          <p className="muted small">
            Document status and source references are returned by the server.
            Download access is not provided here.
          </p>
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
  loading = false,
}: {
  marketplace: MarketplaceSnapshot | null;
  selectedMerchantId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const merchants = marketplace?.merchants ?? [];
  const { filtered, selected } = merchantSelection(
    merchants,
    query,
    selectedMerchantId,
  );
  return (
    <div className="directory-layout evidence-directory" aria-busy={loading}>
      <section className="panel merchant-directory">
        <div className="section-heading">
          <h2>Supplier directory</h2>
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
        <p className="evidence-result-count" role="status">
          {loading
            ? "Loading merchant data…"
            : `${filtered.length} of ${merchants.length} merchants`}
        </p>
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
              loading
                ? "Loading merchants"
                : query.trim()
                  ? "No matching merchants"
                  : marketplace
                    ? "No merchants returned"
                    : "Merchant data unavailable"
            }
          >
            {loading
              ? "Waiting for the server read model."
              : query.trim()
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

export function RealityView(
  props: React.ComponentProps<typeof KnowledgeGraph>,
) {
  return <KnowledgeGraph {...props} />;
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

                  <Badge value={provider.status} />
                </div>
                {provider.mode === "live" && <p>{provider.detail}</p>}
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

export function ExecutionView({
  order,
  marketplace,
  busy,
  actionsBlocked = false,
  blockedReason,
  demoMode,
  resetting = false,
  onApprove,
  onOffline,
  onReset,
  events = [],
}: {
  order: OrderSessionSnapshot | null;
  marketplace: MarketplaceSnapshot | null;
  busy: boolean;
  actionsBlocked?: boolean;
  blockedReason?: string | null;
  demoMode: boolean;
  resetting?: boolean;
  onApprove: () => void;
  onOffline: (merchantId: string) => void;
  onReset?: () => void;
  events?: MoleculeEvent[];
}) {
  return (
    <div className="stack decision-execution">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">COMMERCE EXECUTION</p>
            <h2>
              {order?.executionReceipt
                ? "Commerce records & outcomes"
                : "Review before creating commerce records"}
            </h2>
          </div>
          {order && <Badge value={order.state} />}
        </div>
        {order ? (
          <>
            <DecisionApproval
              order={order}
              marketplace={marketplace}
              busy={busy}
              actionsBlocked={actionsBlocked}
              blockedReason={blockedReason}
              events={events}
              onApprove={onApprove}
            />
            <DecisionReceipts order={order} marketplace={marketplace} />
          </>
        ) : (
          <Empty title="No plan to approve">
            Describe the outcome in Command Center, then review the
            solver&apos;s plan here.
          </Empty>
        )}
      </section>
      <DecisionRecovery
        key={order?.orderId ?? "no-project"}
        order={order}
        marketplace={marketplace}
        busy={busy || actionsBlocked}
        demoMode={demoMode}
        resetting={resetting}
        onOffline={onOffline}
        onReset={onReset}
      />
    </div>
  );
}

/**
 * The catalog item and live resource readings a plan node was certified against.
 *
 * `selectedItem` and `resourceRefs` already travel on every PlanNode via
 * `CatalogReferencesShape`; until now the UI dropped them. Showing them is what lets an
 * operator see WHICH SKU and WHICH inventory reading a decision rests on.
 *
 * `available` is the value observed at `observedAt`, not a live reading. It is labelled that
 * way so a stale number is never mistaken for current truth.
 */
function NodeCatalogDetail({
  node,
}: {
  node: ProductionPlan["nodes"][number];
}) {
  const item = node.selectedItem;
  const resources = node.resourceRefs ?? [];
  if (!item && !resources.length) return null;
  const adminUrl =
    item?.shopDomain && item.variantGid
      ? variantAdminUrl(item.shopDomain, item.variantGid)
      : undefined;
  return (
    <>
      <h3>Catalog item and inventory</h3>
      {item ? (
        <dl className="detail-grid">
          <div>
            <dt>SKU</dt>
            <dd>
              <code>{item.sku}</code>
            </dd>
          </div>
          <div>
            <dt>Item kind</dt>
            <dd>{humanize(item.itemKind)}</dd>
          </div>
          <div>
            <dt>Store</dt>
            <dd>{item.shopDomain ?? "Not mapped to a store"}</dd>
          </div>
          <div>
            <dt>Variant</dt>
            <dd>
              {item.variantGid ? (
                adminUrl ? (
                  <a href={adminUrl} target="_blank" rel="noreferrer">
                    <code>{item.variantGid}</code>
                  </a>
                ) : (
                  <code>{item.variantGid}</code>
                )
              ) : (
                "Not provisioned"
              )}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="muted">
          This node is not bound to a catalog item, so no SKU or store is
          available.
        </p>
      )}
      {resources.length > 0 && (
        <ul className="detail-list">
          {resources.map((resource) => (
            <li key={resource.resourceId}>
              <strong>{humanize(resource.kind)}</strong>{" "}
              <code>{resource.resourceId}</code>
              <br />
              {resource.available} {resource.unit} available
              {resource.periodMinutes
                ? ` per ${resource.periodMinutes} minutes`
                : ""}{" "}
              · {resource.unitsPerItem} {resource.unit} per item
              <br />
              <span className="muted small">
                Observed {dateLabel(resource.observedAt, true)} ·{" "}
                {resource.sourceReference}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function NodeDetail({
  node: selectedNode,
  order,
  currency,
  marketplace,
  onMerchant,
  selection,
}: {
  node: ProductionPlan["nodes"][number];
  order: OrderSessionSnapshot;
  currency: ProductionPlan["currency"] | undefined;
  marketplace: MarketplaceSnapshot | null;
  onMerchant: (id: string) => void;
  selection?: PlanSelection;
}) {
  const evidence = nodeEvidenceContext(
    order.activePlan,
    selectedNode,
    selection,
  );
  const node = evidence.node;
  const merchant = marketplace?.merchants.find(
    (item) => item.merchantId === node.merchantId,
  );
  const candidate = evidence.current
    ? (order.candidates.find(
        (item) =>
          item.capabilityId === node.capabilityId &&
          item.merchantId === node.merchantId,
      ) ??
      merchant?.capabilities.find(
        (item) => item.capabilityId === node.capabilityId,
      ))
    : undefined;
  const quote = evidence.current
    ? order.quotes.find(
        (item) =>
          item.capabilityId === node.capabilityId &&
          item.merchantId === node.merchantId,
      )
    : undefined;
  const claims =
    merchant?.claims.filter((claim) =>
      candidate?.capability.sourceClaimIds.includes(claim.claimId),
    ) ?? [];
  return (
    <div className="evidence-node-detail">
      <div className="node-detail-head">
        <span
          className="node-kind-tile"
          style={{ color: kindColorVar[node.kind] }}
        >
          <PlanKindIcon kind={node.kind} />
        </span>
        <div>
          <p className="eyebrow">{humanize(node.kind)}</p>
          <h2>{merchant?.name ?? node.merchantId}</h2>
        </div>
      </div>
      <p>{candidate?.capability.name ?? node.capabilityId}</p>
      {selection && (
        <p className="muted small">
          Plan <code>{selection.planId}</code> · node{" "}
          <code>{selection.nodeId}</code>
        </p>
      )}
      {!evidence.current && (
        <p className="inline-warning">
          This selection is historical or its plan context is no longer current.
          Node values belong to the selected plan; historical quotes and
          evidence snapshots are not available. Current merchant data is
          separate.
        </p>
      )}
      <dl className="detail-grid">
        <div>
          <dt>Node cost</dt>
          <dd>
            {money(
              node.totalCost,
              evidence.currency ?? (evidence.current ? currency : undefined),
            )}
          </dd>
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
      <NodeCatalogDetail node={node} />
      <h3>
        {evidence.current ? "Current quote" : "Historical quote unavailable"}
      </h3>
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
      <h3>
        {evidence.current
          ? "Current source claims"
          : "Historical source evidence unavailable"}
      </h3>
      {evidence.current ? (
        <ClaimTable claims={claims} />
      ) : (
        <p className="muted">
          Open the merchant twin to inspect current evidence. It does not
          establish the evidence used by this historical plan.
        </p>
      )}
      <button
        type="button"
        className="secondary"
        onClick={() => onMerchant(node.merchantId)}
      >
        Open merchant twin →
      </button>
    </div>
  );
}
