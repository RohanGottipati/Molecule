#!/usr/bin/env node
// Builds a self-contained HTML report of a run: the scorecard, what it refused
// to do, and the questions it wants a human to answer. No server, no build step -
// open the file.
//
//   node --env-file=../.env --env-file=../.env.local pipeline/report.mjs --run=<runId> --out=../report.html

import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "./db.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const out = resolve(args.out ? String(args.out) : join(HERE, "..", "report.html"));

const db = await connect({ max: 4 });
const runId = String(args.run ?? (await db.query(`select run_id from rox_ingest_runs where status='completed' order by started_at desc limit 1`)).rows[0]?.run_id);
const { rows: [run] } = await db.query(`select * from rox_ingest_runs where run_id = $1`, [runId]);
if (!run) { console.error(`no such run: ${runId}`); process.exit(1); }

const { rows: scores } = await db.query(`select variant, metric, value, detail from rox_scorecard where run_id = $1`, [runId]);
const { rows: [summary] } = await db.query(`select * from rox_run_summary where run_id = $1`, [runId]);
const { rows: conflicts } = await db.query(
  `select r.merchant_id, r.field, r.explanation, r.scores, q.draft_message
     from canonical_resolutions r
     left join rox_review_queue q on q.merchant_id = r.merchant_id and q.field = r.field and q.kind = 'conflict'
    where r.status = 'conflicted' order by r.merchant_id, r.field limit 12`);
const { rows: quarantine } = await db.query(
  `select q.field, q.reason, q.raw_value, a.source_path from quarantined_claims q
     join raw_artifacts a using (artifact_id) where q.run_id = $1 limit 12`, [runId]);
const { rows: injections } = await db.query(
  `select detail->>'sourcePath' as path, detail->'patterns' as patterns from rox_review_queue
    where run_id = $1 and kind = 'injection' limit 12`, [runId]);
const { rows: links } = await db.query(
  `select alias, resolved_id, method, round(score,3) as score, status from rox_entity_links
    where method <> 'exact' or status <> 'linked' order by status, method limit 14`);
const { rows: provenance } = await db.query(
  `select merchant_id, field, normalized_value, normalized_unit, source_kind, evidence_text
     from rox_fact_provenance where evidence_text is not null order by ingested_at desc limit 10`);
const { rows: cost } = await db.query(
  `select stage, model, count(*)::int as calls, round(sum(cost_usd),4) as usd,
          round(avg(latency_ms)) as avg_ms from rox_llm_calls where run_id = $1 group by 1,2 order by 4 desc`, [runId]);

const by = (variant) => Object.fromEntries(scores.filter((s) => s.variant === variant).map((s) => [s.metric, s.value === null ? null : Number(s.value)]));
const agent = by("agent");
const baseline = by("regex_baseline");
const hasBaseline = Object.keys(baseline).length > 0;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (v) => (v === null || v === undefined ? "n/a" : `${v}%`);

const COMPARE = [
  ["extraction_recall_pct", "Extraction recall"],
  ["extraction_precision_pct", "Extraction precision"],
  ["attribution_accuracy_pct", "Attribution accuracy"],
  ["normalization_accuracy_pct", "Normalisation accuracy"],
  ["ambiguity_held_pct", "Ambiguity held"],
  ["quarantine_recall_pct", "Quarantine recall"],
  ["injection_defense_pct", "Injection defense"],
  ["outlier_containment_pct", "Outlier containment"],
];

// Horizontal bars: one row per metric, two series when a baseline exists.
// 4px rounded data-ends, a 2px surface gap between adjacent fills, values
// direct-labelled so identity never rests on colour alone.
function barChart() {
  const rows = COMPARE.filter(([k]) => agent[k] !== null && agent[k] !== undefined);
  const rowH = hasBaseline ? 44 : 30;
  const barH = hasBaseline ? 15 : 18;
  const top = 8, labelW = 186, valueW = 52;
  const width = 720, plotW = width - labelW - valueW;
  const height = top + rows.length * rowH + 22;
  const x = (v) => (plotW * v) / 100;

  const ticks = [0, 25, 50, 75, 100].map((t) => `
    <line x1="${labelW + x(t)}" y1="${top}" x2="${labelW + x(t)}" y2="${top + rows.length * rowH - 8}" class="grid"/>
    <text x="${labelW + x(t)}" y="${height - 6}" class="tick" text-anchor="middle">${t}</text>`).join("");

  const bars = rows.map(([key, label], i) => {
    const y = top + i * rowH;
    const a = agent[key] ?? 0;
    const b = baseline[key];
    const one = (value, series, offset, h) => value === null || value === undefined ? "" : `
      <g class="bar">
        <rect x="${labelW}" y="${y + offset}" width="${Math.max(2, x(value))}" height="${h}" rx="4" class="fill-${series}"/>
        <text x="${labelW + Math.max(2, x(value)) + 8}" y="${y + offset + h - 3}" class="value">${value}%</text>
        <title>${esc(label)} — ${series === 1 ? "agent" : "regex baseline"}: ${value}%</title>
      </g>`;
    return `
      <text x="${labelW - 12}" y="${y + (hasBaseline ? 13 : 14)}" class="rowlabel" text-anchor="end">${esc(label)}</text>
      ${one(a, 1, 0, barH)}
      ${hasBaseline ? one(b ?? 0, 2, barH + 2, barH) : ""}`;
  }).join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Scorecard by metric">${ticks}${bars}</svg>`;
}

const tile = (label, value, note, tone = "") => `
  <div class="tile ${tone}">
    <div class="tile-value">${esc(value)}</div>
    <div class="tile-label">${esc(label)}</div>
    ${note ? `<div class="tile-note">${esc(note)}</div>` : ""}
  </div>`;

const table = (headers, rows) => rows.length ? `
  <table>
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>` : `<p class="empty">Nothing in this category for this run.</p>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rox Ingestion Report</title>
<style>
  :root {
    color-scheme: light;
    --surface-0: #f4f4f2; --surface-1: #fcfcfb; --border: #e0dfda;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #77756e;
    --series-1: #2a78d6; --series-2: #eb6834;
    --good: #0ca30c; --warning: #fab219; --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --surface-0: #111110; --surface-1: #1a1a19; --border: #33322e;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8f8d83;
      --series-1: #3987e5; --series-2: #d95926;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-0: #111110; --surface-1: #1a1a19; --border: #33322e;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8f8d83;
    --series-1: #3987e5; --series-2: #d95926;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--surface-0); color: var(--text-primary);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 40px 16px 72px; }
  h1 { font-size: 27px; margin: 0 0 6px; letter-spacing: -0.015em; }
  h2 { font-size: 18px; margin: 40px 0 10px; letter-spacing: -0.01em; }
  .sub { color: var(--text-secondary); margin: 0 0 28px; }
  .sub code { font-size: 13px; color: var(--text-muted); }
  section { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 20px 22px; margin-bottom: 18px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
  .tile-value { font-size: 30px; font-weight: 640; letter-spacing: -0.02em; }
  .tile-label { color: var(--text-secondary); font-size: 13px; margin-top: 2px; }
  .tile-note { color: var(--text-muted); font-size: 12px; margin-top: 6px; }
  .tile.good .tile-value { color: var(--good); }
  .tile.warn .tile-value { color: var(--warning); }
  .legend { display: flex; gap: 18px; align-items: center; margin: 4px 0 14px; font-size: 13px; color: var(--text-secondary); }
  .swatch { width: 11px; height: 11px; border-radius: 3px; display: inline-block; margin-right: 7px; vertical-align: -1px; }
  .grid { stroke: var(--border); stroke-width: 1; }
  .tick, .rowlabel, .value { fill: var(--text-secondary); font-size: 12px; }
  .rowlabel { fill: var(--text-primary); font-size: 13px; }
  .value { fill: var(--text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
  .fill-1 { fill: var(--series-1); } .fill-2 { fill: var(--series-2); }
  .bar:hover rect { opacity: 0.82; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--text-muted); font-weight: 560; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 9px 10px 9px 0; border-bottom: 1px solid var(--border); vertical-align: top; color: var(--text-secondary); }
  td:first-child, th:first-child { padding-left: 2px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: var(--text-primary); }
  .quote { color: var(--text-muted); font-style: italic; }
  .draft { white-space: pre-wrap; font-size: 12.5px; background: var(--surface-0); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-top: 8px; color: var(--text-secondary); }
  .empty { color: var(--text-muted); font-size: 13px; margin: 4px 0 0; }
  details summary { cursor: pointer; color: var(--text-secondary); font-size: 13px; }
  .foot { color: var(--text-muted); font-size: 12px; margin-top: 28px; }
  @media (max-width: 640px) { main { padding: 24px 16px 56px; } h1 { font-size: 23px; } }
</style>
</head>
<body>
<main>
  <h1>Rox ingestion report</h1>
  <p class="sub">${esc(summary?.artifacts ?? 0)} messy supplier artifacts &rarr; Tiger, scored against hidden ground truth.<br>
     <code>run ${esc(runId)} &middot; batch ${esc(run.batch_id)} &middot; ${esc(new Date(run.started_at).toISOString().slice(0, 16).replace("T", " "))}Z</code></p>

  <div class="tiles">
    ${tile("Injection defense", pct(agent.injection_defense_pct), "instructions hidden in supplier text", agent.injection_defense_pct === 100 ? "good" : "warn")}
    ${tile("Hallucination rate", pct(agent.hallucination_rate_pct), "candidates dropped for unquotable evidence", agent.hallucination_rate_pct === 0 ? "good" : "warn")}
    ${tile("Extraction recall", pct(agent.extraction_recall_pct), "of facts the documents state")}
    ${tile("Outlier containment", pct(agent.outlier_containment_pct), "source-side errors kept out of the answer")}
    ${tile("Claims written", String(summary?.claimed ?? 0), `${summary?.quarantined ?? 0} quarantined, ${summary?.open_reviews ?? 0} queued for a human`)}
    ${tile("Cost", `$${Number(run.cost_usd).toFixed(3)}`, `${cost.reduce((s, c) => s + c.calls, 0)} model calls`)}
  </div>

  <h2>Scorecard${hasBaseline ? " vs the regex control group" : ""}</h2>
  <section>
    ${hasBaseline ? `<div class="legend">
      <span><span class="swatch" style="background:var(--series-1)"></span>Agent</span>
      <span><span class="swatch" style="background:var(--series-2)"></span>Regex baseline</span>
    </div>` : `<div class="legend"><span><span class="swatch" style="background:var(--series-1)"></span>Agent — no baseline run scored yet</span></div>`}
    ${barChart()}
    <details style="margin-top:14px">
      <summary>Table view</summary>
      ${table(["Metric", "Agent", hasBaseline ? "Regex baseline" : "—"],
        COMPARE.map(([k, label]) => [esc(label), pct(agent[k]), hasBaseline ? pct(baseline[k]) : "—"]))}
    </details>
  </section>

  <h2>What it refused to decide</h2>
  <section>
    <p class="sub" style="margin-bottom:14px">Conflicted fields stay conflicted. The draft below was written by the agent and is waiting for a human to approve before anything is sent.</p>
    ${table(["Supplier", "Field", "Why"], conflicts.map((c) => [
      `<code>${esc(c.merchant_id)}</code>`,
      `<code>${esc(c.field)}</code>`,
      `${esc(c.explanation)}${c.draft_message ? `<div class="draft">${esc(c.draft_message)}</div>` : ""}`,
    ]))}
  </section>

  <h2>What it would not read</h2>
  <section>
    ${table(["Source", "Field", "Value as written", "Reason"], quarantine.map((q) => [
      `<code>${esc(q.source_path)}</code>`, `<code>${esc(q.field)}</code>`,
      `<span class="quote">${esc(q.raw_value?.value ?? "")}</span>`, esc(q.reason),
    ]))}
  </section>

  <h2>Instructions hidden in supplier documents</h2>
  <section>
    <p class="sub" style="margin-bottom:14px">Detected by a regex guard and the model independently. Every value from these documents was blocked before it could become a claim.</p>
    ${table(["Document", "Pattern matched"], injections.map((i) => [
      `<code>${esc(i.path)}</code>`, `<code>${esc(JSON.stringify(i.patterns ?? []).slice(0, 110))}</code>`,
    ]))}
  </section>

  <h2>Entity resolution</h2>
  <section>
    <p class="sub" style="margin-bottom:14px">Names as suppliers write them, resolved to one record — or handed to a human when the match was not decisive.</p>
    ${table(["Alias in the document", "Resolved to", "How", "Score", "Status"], links.map((l) => [
      `<code>${esc(l.alias)}</code>`, l.resolved_id ? `<code>${esc(l.resolved_id)}</code>` : "<em>unresolved</em>",
      esc(l.method), l.score ?? "—", esc(l.status),
    ]))}
  </section>

  <h2>Every fact carries its sentence</h2>
  <section>
    ${table(["Supplier", "Field", "Value", "Source", "The words it came from"], provenance.map((p) => [
      `<code>${esc(p.merchant_id)}</code>`, `<code>${esc(p.field)}</code>`,
      `${esc(JSON.stringify(p.normalized_value))} ${esc(p.normalized_unit ?? "")}`, esc(p.source_kind),
      `<span class="quote">${esc(String(p.evidence_text).slice(0, 120))}</span>`,
    ]))}
  </section>

  <h2>What it cost</h2>
  <section>
    ${table(["Stage", "Model", "Calls", "USD", "Avg latency"], cost.map((c) => [
      esc(c.stage), `<code>${esc(c.model)}</code>`, c.calls, `$${c.usd}`, `${c.avg_ms ?? "—"} ms`,
    ]))}
  </section>

  <p class="foot">Generated by <code>rox_data/pipeline/report.mjs</code>. Corpus artifacts are synthetic and deterministic from a seed;
  the Open Food Facts and UCI Online Retail II rows in the same database are real. Ground truth lives in <code>rox_truth</code>, which no pipeline stage reads.</p>
</main>
</body>
</html>`;

await writeFile(out, html, "utf8");
console.log(`report written to ${out} (${(html.length / 1024).toFixed(0)} KB)`);
await db.end();
