"use client";

import { useMemo, useState } from "react";
import type { CanonicalClaim, MarketplaceSnapshot } from "@molecule/contracts";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
  type Edge,
} from "@xyflow/react";
import { evidenceGroups, merchantSelection } from "../lib/decisionEvidence";
import { dateLabel, displayValue, humanize } from "../lib/workspace";
import { GraphDetailPanel } from "./GraphDetailPanel";
import { KnowledgeAtlas, type KnowledgeSelection } from "./KnowledgeAtlas";
import { ProductionEdge } from "./PlanGraph";

type Card = {
  title: string;
  subtitle: string;
  kind: "Source" | "Fact" | "Supplier";
  status: string;
  warning: boolean;
  claims: CanonicalClaim[];
  onSelect: () => void;
  selected: boolean;
};
function KnowledgeNode({ data }: NodeProps<Node<Card>>) {
  return (
    <button
      type="button"
      className={`production-node nodrag ${data.selected ? "node-selected" : ""} ${data.warning ? "node-failed" : ""}`}
      onClick={data.onSelect}
      aria-pressed={data.selected}
    >
      <span className="node-glow-ring" aria-hidden="true" />
      {data.kind !== "Source" && (
        <Handle type="target" position={Position.Left} />
      )}
      <span
        className={`node-kind-tile knowledge-icon-${data.kind.toLowerCase()}`}
        aria-hidden="true"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {data.kind === "Source" ? (
            <>
              <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6" />
            </>
          ) : data.kind === "Fact" ? (
            <>
              <circle cx="12" cy="12" r="8" />
              <path d="m8 12 3 3 5-6" />
            </>
          ) : (
            <>
              <path d="M4 21V7l8-4 8 4v14M2 21h20M9 21v-5h6v5M8 9h1m6 0h1M8 12h1m6 0h1" />
            </>
          )}
        </svg>
      </span>
      <span className="node-content">
        <span className="node-head">
          <strong title={data.title}>{data.title}</strong>
          <span
            className={`node-status node-status-${data.warning ? "warning" : "neutral"}`}
          >
            {data.status}
          </span>
        </span>
        <span className="node-subtitle" title={data.subtitle}>
          {data.subtitle}
        </span>
        <span className="node-metadata">
          {data.kind} · {data.claims.length} claim
          {data.claims.length === 1 ? "" : "s"}
        </span>
      </span>
      {data.kind !== "Supplier" && (
        <Handle type="source" position={Position.Right} />
      )}
    </button>
  );
}
const nodeTypes = { knowledge: KnowledgeNode };
const edgeTypes = { knowledge: ProductionEdge };
const pageSize = 3;

export function KnowledgeGraph({
  marketplace,
  loading = false,
  error,
  onRefresh,
}: {
  marketplace: MarketplaceSnapshot | null;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}) {
  const [atlasDetail, setAtlasDetail] = useState<KnowledgeSelection | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const { filtered, selected: merchant } = useMemo(
    () => merchantSelection(marketplace?.merchants ?? [], query, merchantId),
    [marketplace, query, merchantId],
  );
  const groups = useMemo(
    () => evidenceGroups(merchant?.claims ?? [], filter),
    [merchant, filter],
  );
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(groups.length / pageSize) - 1),
  );
  const visible = groups.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const nodes: Node<Card>[] = [];
  const edges: Edge<{ animated: boolean }>[] = [];
  const sources = new Map<string, CanonicalClaim[]>();
  const sourceKey = (c: CanonicalClaim) => c.source.kind;
  for (const group of visible)
    for (const claim of group.claims) {
      const key = sourceKey(claim);
      sources.set(key, [...(sources.get(key) ?? []), claim]);
    }
  const height = Math.max(visible.length, sources.size, 1) * 145;
  function card(
    id: string,
    x: number,
    y: number,
    data: Omit<Card, "onSelect" | "selected">,
  ) {
    nodes.push({
      id,
      type: "knowledge",
      position: { x, y },
      data: {
        ...data,
        selected: selected === id,
        onSelect: () => setSelected(id),
      },
    });
  }
  function edge(source: string, target: string, animated: boolean) {
    edges.push({
      id: JSON.stringify([source, target]),
      source,
      target,
      type: "knowledge",
      data: { animated },
    });
  }
  if (merchant) {
    card("supplier", 1000, height / 2 - 55, {
      title: merchant.name,
      subtitle: `${merchant.capabilities.length} capabilities · ${merchant.claims.length} evidence records`,
      kind: "Supplier",
      status: humanize(merchant.status),
      warning: merchant.status === "offline",
      claims: merchant.claims,
    });
    [...sources.entries()].forEach(([key, claims], index) => {
      card(`source:${key}`, 0, ((index + 0.5) * height) / sources.size - 55, {
        title: `${claims[0]!.source.kind === "api" ? "API" : claims[0]!.source.kind === "csv" ? "CSV" : humanize(claims[0]!.source.kind)} records`,
        subtitle: `${new Set(claims.map((c) => c.source.reference)).size} sources · contributing to shown facts`,
        kind: "Source",
        status: "Recorded",
        warning: false,
        claims,
      });
    });
    visible.forEach((group, index) => {
      const id = `fact:${group.key}`;
      const statuses = [
        ...new Set(group.claims.map((c) => c.resolutionStatus)),
      ];
      const capability = merchant.capabilities.find((c) =>
        group.field.startsWith(`${c.capabilityId}.`),
      );
      const scope =
        capability?.capability.name ??
        (group.field.includes(".")
          ? humanize(group.field.split(".").slice(0, -1).join(" "))
          : "Supplier fact");
      card(id, 500, ((index + 0.5) * height) / visible.length - 55, {
        title: humanize(group.field.split(".").at(-1) ?? group.field),
        subtitle: `${scope} · ${[
          ...new Set(
            group.claims.map((c) =>
              `${displayValue(c.normalizedValue)} ${c.normalizedUnit ?? ""}`.trim(),
            ),
          ),
        ].join(" / ")}`,
        kind: "Fact",
        status: group.conflicted
          ? "Conflicted"
          : statuses.length === 1
            ? humanize(statuses[0]!)
            : "Mixed",
        warning: group.conflicted || statuses.includes("quarantined"),
        claims: group.claims,
      });
      for (const key of new Set(group.claims.map(sourceKey)))
        edge(
          `source:${key}`,
          id,
          group.claims.some(
            (c) => sourceKey(c) === key && c.resolutionStatus === "active",
          ),
        );
      edge(
        id,
        "supplier",
        group.claims.some((c) => c.resolutionStatus === "active") &&
          !group.conflicted,
      );
    });
  }
  const detail = atlasDetail ?? nodes.find((n) => n.id === selected)?.data;
  const detailMerchant = marketplace?.merchants.find(
    (m) =>
      m.merchantId ===
      (atlasDetail?.merchantId ?? detail?.claims[0]?.merchantId),
  );
  const close = () => {
    setSelected(null);
    setAtlasDetail(null);
  };
  function reset() {
    setPage(0);
    close();
  }
  return (
    <section
      className="plan-actions-dark canvas-plan knowledge-canvas"
      aria-label="Supplier knowledge graph"
      aria-busy={loading}
    >
      {error && (
        <div className="knowledge-error" role="status">
          <span>
            Source refresh failed
            {marketplace ? " · showing last received evidence" : ""}. {error}
          </span>
          <button
            className="text-button"
            disabled={loading}
            onClick={onRefresh}
          >
            Retry
          </button>
        </div>
      )}
      <header className="knowledge-header">
        <div>
          <p className="eyebrow">SUPPLIER KNOWLEDGE</p>
          <h1>Sources</h1>
          <p className="muted">Explore the evidence behind every fact.</p>
          {onRefresh && (
            <button
              className="text-button"
              onClick={onRefresh}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh evidence"}
            </button>
          )}
        </div>
        <div className="knowledge-filters">
          <label>
            <span>Find supplier</span>
            <input
              type="search"
              placeholder="Search suppliers"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                reset();
              }}
            />
          </label>
          <label>
            <span>Supplier · {filtered.length}</span>
            <select
              value={merchantId ?? ""}
              onChange={(e) => {
                setMerchantId(e.target.value || null);
                reset();
              }}
            >
              <option value="">All suppliers · network</option>
              {filtered.map((m) => (
                <option key={m.merchantId} value={m.merchantId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Evidence status</span>
            <select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                reset();
              }}
            >
              <option value="all">All evidence</option>
              {[
                "active",
                "conflicted",
                "unknown",
                "quarantined",
                "superseded",
              ].map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <div className="decision-plan-graph">
        <div
          className="graph"
          role="region"
          aria-label="Source to fact to supplier relationships"
        >
          {!merchantId && filtered.length > 0 ? (
            <KnowledgeAtlas
              merchants={filtered}
              filter={filter}
              onSelect={setAtlasDetail}
            />
          ) : merchant && visible.length > 0 ? (
            <ReactFlow
              key={`${merchant.merchantId}-${filter}-${safePage}`}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.15}
              maxZoom={1.5}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              onPaneClick={close}
              panOnScroll
              preventScrolling={false}
            >
              <Background gap={28} size={1} color="#d5dde1" />
              <Controls showInteractive={false} orientation="horizontal" />
            </ReactFlow>
          ) : (
            <div className="knowledge-empty">
              <h2>
                {loading
                  ? "Loading evidence…"
                  : !merchant
                    ? "No matching suppliers"
                    : "No matching evidence"}
              </h2>
              <p>
                {loading
                  ? "Building the graph from available records."
                  : "Try another supplier or evidence status. Missing records do not mean a fact is known."}
              </p>
              {merchant && (
                <button
                  className="secondary"
                  onClick={() => setSelected("supplier")}
                >
                  Inspect supplier
                </button>
              )}
            </div>
          )}
          {detail && (
            <GraphDetailPanel
              key={selected}
              onClose={close}
              title={`${detail.kind} details`}
            >
              <h2>{detail.title}</h2>
              <span
                className={`node-status node-status-${detail.warning ? "warning" : "neutral"}`}
              >
                {detail.status}
              </span>
              <p className="muted knowledge-reference">{detail.subtitle}</p>
              {detail.kind === "Supplier" &&
                detailMerchant?.capabilities
                  .filter((c) => c.blockedReasons.length)
                  .map((c) => (
                    <div className="knowledge-restriction" key={c.capabilityId}>
                      <strong>{c.capability.name}</strong>
                      <ul>
                        {c.blockedReasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
              {detail.kind !== "Supplier" && !detail.claims.length && (
                <p className="muted">
                  No linked source claims were returned for this record.
                </p>
              )}
              {detail.kind === "Supplier" ? (
                <p className="muted">
                  Select a fact to inspect its sources and confidence. Missing
                  records do not establish evidence completeness.
                </p>
              ) : (
                detail.claims.map((c) => (
                  <article className="knowledge-evidence" key={c.claimId}>
                    <div className="knowledge-evidence-head">
                      <strong>
                        {displayValue(c.normalizedValue)} {c.normalizedUnit}
                      </strong>
                      <span
                        className={`node-status node-status-${c.resolutionStatus === "conflicted" || c.resolutionStatus === "quarantined" ? "warning" : "neutral"}`}
                      >
                        {humanize(c.resolutionStatus)}
                      </span>
                    </div>
                    <p>{humanize(c.field)}</p>
                    <p className="knowledge-reference">
                      {humanize(c.source.kind)} · {c.source.reference}
                    </p>
                    {c.evidenceText && (
                      <blockquote>{c.evidenceText}</blockquote>
                    )}
                    <details className="knowledge-identity">
                      <summary>Record identity</summary>
                      <p>{c.claimId}</p>
                      {c.source.checksum && (
                        <p>Checksum: {c.source.checksum}</p>
                      )}
                    </details>
                    <dl className="detail-grid">
                      <div>
                        <dt>Confidence</dt>
                        <dd>{Math.round(c.extractionConfidence * 100)}%</dd>
                      </div>
                      <div>
                        <dt>Authority</dt>
                        <dd>{Math.round(c.sourceAuthority * 100)}%</dd>
                      </div>
                      <div>
                        <dt>Observed</dt>
                        <dd>
                          {c.observedAt ? dateLabel(c.observedAt) : "Unknown"}
                        </dd>
                      </div>
                      <div>
                        <dt>Ingested</dt>
                        <dd>{dateLabel(c.ingestedAt)}</dd>
                      </div>
                    </dl>
                    {c.resolutionStatus === "conflicted" && (
                      <p className="knowledge-restriction">
                        Sources disagree. This fact remains unresolved.
                      </p>
                    )}
                  </article>
                ))
              )}
            </GraphDetailPanel>
          )}
        </div>
      </div>
      <footer className="knowledge-footer">
        <div className="knowledge-legend">
          <span>
            <i className="knowledge-dot-source" />
            Source
          </span>
          <span>→</span>
          <span>
            <i className="knowledge-dot-fact" />
            Fact
          </span>
          <span>→</span>
          <span>
            <i className="knowledge-dot-supplier" />
            Supplier
          </span>
          {!merchantId && (
            <>
              <span>
                <i className="knowledge-dot-capability" />
                Capability
              </span>
              <span>
                <i className="knowledge-dot-warning" />
                Restricted / conflicted
              </span>
            </>
          )}
        </div>
        <span className="knowledge-motion-note">
          Connections show provenance, not live activity.
        </span>
        {merchantId && (
          <div className="knowledge-pagination">
            <button
              className="text-button"
              disabled={safePage === 0}
              onClick={() => {
                setPage(safePage - 1);
                close();
              }}
              aria-label="Previous facts"
            >
              ←
            </button>
            <span>
              {groups.length
                ? `${safePage * pageSize + 1}–${Math.min((safePage + 1) * pageSize, groups.length)}`
                : "0"}{" "}
              of {groups.length} facts
            </span>
            <button
              className="text-button"
              disabled={(safePage + 1) * pageSize >= groups.length}
              onClick={() => {
                setPage(safePage + 1);
                close();
              }}
              aria-label="Next facts"
            >
              →
            </button>
          </div>
        )}
      </footer>
    </section>
  );
}
