// The control group: extraction by regular expression, the way this problem is
// usually attacked before anyone reaches for a model. It feeds the identical
// link -> normalize -> resolve path, so a scorecard difference is attributable
// to extraction alone.
//
//   node --env-file=../.env --env-file=../.env.local pipeline/run.mjs --stages=baseline,link,normalize,resolve

import { shortId, bumpStage, emitEvent } from "./db.mjs";
import { detectInjection, evidencePresent } from "./extract.mjs";

const PATTERNS = [
  { field: "capacity", re: /(\d[\d,]*)\s*(?:units?|pieces?|kits?|packs?|hoodies|bottles)?\s*(?:\/|per\s+|a\s+|every\s+)(day|week|month)/gi,
    value: (m) => m[1], unit: (m) => `units/${m[2].toLowerCase()}`, period: (m) => m[2].toLowerCase() },
  { field: "capacity", re: /\b(?:capacity|daily_capacity|on_hand|available)\D{0,20}(\d[\d,]*)/gi,
    value: (m) => m[1], unit: () => "", period: () => "" },
  { field: "lead_time_hours", re: /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b|business\s+days?|working\s+days?|days?)/gi,
    value: (m) => m[1], unit: (m) => m[2].toLowerCase(), period: () => "" },
  { field: "price", re: /[$]\s*(\d+(?:[.,]\d+)?)\s*(CAD|USD|GBP|EUR)?/gi,
    value: (m) => m[1], unit: (m) => m[2] ?? "", period: () => "" },
  { field: "price", re: /\b(CAD|USD|GBP|EUR)\s*(\d+(?:[.,]\d+)?)/gi,
    value: (m) => m[2], unit: (m) => m[1], period: () => "" },
  { field: "moq", re: /\b(?:moq|minimum(?:\s+order)?(?:\s+quantity)?)\D{0,15}(\d+)/gi,
    value: (m) => m[1], unit: () => "units", period: () => "" },
  { field: "moq", re: /(\d+)\s*(?:unit|pcs?|piece)\s*minimum/gi,
    value: (m) => m[1], unit: () => "units", period: () => "" },
];

/** The best a name-matching heuristic does without a model: domains and handles. */
function merchantHint(text) {
  const domain = text.match(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/);
  if (domain && !/molecule/i.test(domain[1])) return domain[1];
  const handle = text.match(/\b([a-z0-9-]+)\.myshopify\.com\b/i);
  if (handle) return handle[1];
  const header = text.split("\n").find((l) => /PRICE LIST|INVOICE/i.test(l));
  return header ? header.replace(/\s*[-–]\s*(PRICE LIST|INVOICE).*/i, "").trim() : null;
}

/** Nearest preceding capability-ish phrase, which is all a regex can manage. */
function subjectHint(text, index) {
  const before = text.slice(Math.max(0, index - 120), index);
  const line = before.split("\n").at(-1) ?? "";
  const words = line.replace(/[^A-Za-z \-]/g, " ").split(/\s+/).filter((w) => w.length > 3);
  return words.slice(-4).join(" ");
}

export async function baseline(db, { runId, batchId, traceId, limit = null }) {
  const counts = { artifacts: 0, candidates: 0, kept: 0, blocked: 0, no_evidence: 0 };
  const { rows } = await db.query(
    `select artifact_id, source_path, content_text from raw_artifacts
      where batch_id = $1 and parse_status = 'parsed'
      order by artifact_id ${limit ? "limit " + Number(limit) : ""}`,
    [batchId],
  );

  for (const artifact of rows) {
    counts.artifacts += 1;
    const text = artifact.content_text;
    const guard = detectInjection(text);
    const hint = merchantHint(text);

    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      for (const match of text.matchAll(pattern.re)) {
        const evidence = match[0];
        counts.candidates += 1;
        const outcome = !evidencePresent(text, evidence) ? "dropped" : guard.detected ? "blocked" : "pending";
        if (outcome === "dropped") counts.no_evidence += 1;
        if (outcome === "blocked") counts.blocked += 1;
        if (outcome === "pending") counts.kept += 1;
        await db.query(
          `insert into rox_extractions
             (extraction_id, run_id, artifact_id, merchant_hint, field, raw_value, raw_unit, evidence_text,
              confidence, injection_flag, outcome, outcome_reason, model, prompt_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'regex_baseline','none')
           on conflict (extraction_id) do nothing`,
          [shortId(runId, artifact.artifact_id, pattern.field, String(match.index), evidence),
           runId, artifact.artifact_id, hint, pattern.field,
           JSON.stringify({ value: pattern.value(match), subjectHint: subjectHint(text, match.index ?? 0), period: pattern.period(match) }),
           pattern.unit(match) || null, evidence, 0.6, guard.detected, outcome,
           outcome === "blocked" ? "Document contains an instruction aimed at the reader" : null],
        );
      }
    }
  }

  await bumpStage(db, runId, "baseline", counts);
  await emitEvent(db, { traceId, type: "rox.baseline.completed", payload: counts });
  return counts;
}
