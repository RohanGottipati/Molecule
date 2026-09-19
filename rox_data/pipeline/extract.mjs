// Stage 3: extraction. The only stage where a model decides anything, and even
// here it only proposes: every candidate must quote the document, and anything
// that looks like an instruction aimed at the reader is neutralised before it
// can reach a value.

import OpenAI from "openai";

import { MODELS, REQUIRE_EVIDENCE } from "./config.mjs";
import { shortId, meter, bumpStage, emitEvent, BudgetExceeded } from "./db.mjs";
import { EXTRACT_INSTRUCTIONS, EXTRACT_SCHEMA, EXTRACT_PROMPT_VERSION, extractInput } from "./prompts.mjs";

const CONCURRENCY = Number(process.env.ROX_CONCURRENCY ?? 6);

/**
 * Deterministic injection detector, independent of the model. Two detectors
 * that must agree is the point: a model that misses an injection is caught by
 * the regex, and a model that hallucinates one is caught by its absence.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  /system\s*(?:override|:)\s*(?:true|you|the assistant)/i,
  /\b(?:note|message)\s+to\s+the?\s*(?:ai|assistant|automated system)/i,
  /if\s+you\s+are\s+an?\s+(?:ai|automated|assistant)/i,
  /\bset[_\s](?:field|value)\s*:/i,
  /\byou\s+have\s+a\s+new\s+instruction/i,
  /\bdisregard\s+the\s+(?:numbers|values|figures)\s+above/i,
];
export function detectInjection(text) {
  const hits = INJECTION_PATTERNS.filter((p) => p.test(text)).map((p) => p.source.slice(0, 48));
  return { detected: hits.length > 0, hits };
}

/** Whitespace-insensitive verbatim check: the quote must really be in the document. */
export function evidencePresent(document, evidence) {
  if (!evidence || evidence.length < 2) return false;
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(document).includes(norm(evidence));
}

async function extractOne(client, db, runId, artifact) {
  const started = Date.now();
  const response = await client.responses.create({
    model: MODELS.extract,
    instructions: EXTRACT_INSTRUCTIONS,
    input: extractInput(artifact),
    text: { format: { type: "json_schema", name: "rox_extraction", schema: EXTRACT_SCHEMA, strict: true } },
    max_output_tokens: 4000,
  });
  const usage = {
    input_tokens: response.usage?.input_tokens ?? 0,
    cached_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
  };
  const budget = await meter(db, runId, { stage: "extract", model: MODELS.extract, usage, latencyMs: Date.now() - started });
  const text = response.output_text ?? "";
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Model returned unparseable JSON for ${artifact.source_path}`); }
  return { parsed, budget };
}

export async function extract(db, { runId, batchId, traceId, limit = null, dry = false }) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 2 });
  const counts = { artifacts: 0, candidates: 0, kept: 0, no_evidence: 0, blocked: 0, injections: 0, errors: 0, cost_usd: 0 };

  // Stratified selection: proportional across artifact types, deterministic order,
  // and never re-extracts an artifact this run already handled.
  const { rows: types } = await db.query(
    `select split_part(source_path, '/', 1) as type, count(*)::int as n
       from raw_artifacts
      where batch_id = $1 and parse_status = 'parsed'
        and not exists (select 1 from rox_extractions x where x.artifact_id = raw_artifacts.artifact_id and x.run_id = $2)
      group by 1 order by 1`,
    [batchId, runId],
  );
  const total = types.reduce((s, t) => s + t.n, 0);
  const selected = [];
  for (const t of types) {
    const quota = limit ? Math.max(1, Math.round((limit * t.n) / total)) : t.n;
    const { rows } = await db.query(
      `select artifact_id, source_path, source_kind, content_text, chaos_profile
         from raw_artifacts
        where batch_id = $1 and parse_status = 'parsed' and split_part(source_path, '/', 1) = $2
          and not exists (select 1 from rox_extractions x where x.artifact_id = raw_artifacts.artifact_id and x.run_id = $3)
        order by artifact_id limit $4`,
      [batchId, t.type, runId, quota],
    );
    selected.push(...rows);
  }
  const work = limit ? selected.slice(0, limit) : selected;

  let aborted = null;
  const queue = [...work];
  async function worker() {
    while (queue.length && !aborted) {
      const artifact = queue.shift();
      counts.artifacts += 1;
      try {
        // The deterministic detector runs first: its verdict is what we store,
        // whatever the model says about itself.
        const guard = detectInjection(artifact.content_text);
        if (guard.detected) counts.injections += 1;

        if (dry) continue;
        const { parsed, budget } = await extractOne(client, db, runId, artifact);
        counts.cost_usd = budget.spent;
        if (budget.spent >= budget.budget) { aborted = new BudgetExceeded(budget.spent, budget.budget); break; }

        const injection = guard.detected || parsed.injectionDetected === true;
        for (const c of parsed.candidates ?? []) {
          counts.candidates += 1;
          const hasEvidence = evidencePresent(artifact.content_text, c.evidence);
          let outcome = "pending";
          let reason = null;
          if (REQUIRE_EVIDENCE && !hasEvidence) {
            outcome = "dropped";
            reason = "Evidence span not found verbatim in the document";
            counts.no_evidence += 1;
          } else if (injection) {
            // Values from a document carrying an injection are held, not stored.
            outcome = "blocked";
            reason = `Document contains an instruction aimed at the reader (${guard.hits.join("; ") || "model-reported"})`;
            counts.blocked += 1;
          } else {
            counts.kept += 1;
          }
          await db.query(
            `insert into rox_extractions
               (extraction_id, run_id, artifact_id, merchant_hint, field, raw_value, raw_unit, evidence_text,
                confidence, ambiguity, observed_at, injection_flag, outcome, outcome_reason, model, prompt_version)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             on conflict (extraction_id) do nothing`,
            [shortId(runId, artifact.artifact_id, c.field, c.subjectHint ?? "", c.value ?? "", c.evidence ?? ""),
             runId, artifact.artifact_id, parsed.merchantHint || null, c.field,
             JSON.stringify({ value: c.value ?? "", subjectHint: c.subjectHint ?? "", period: c.period ?? "" }),
             c.unit || null, c.evidence || null,
             Math.min(1, Math.max(0, Number(c.confidence ?? 0.5))),
             c.ambiguity || null,
             parsed.documentDate && !Number.isNaN(Date.parse(parsed.documentDate)) ? new Date(parsed.documentDate) : null,
             injection, outcome, reason, MODELS.extract, EXTRACT_PROMPT_VERSION],
          );
        }
        if (injection) {
          await db.query(
            `insert into rox_review_queue (task_id, run_id, kind, merchant_hint, detail, proposed_action)
             values ($1,$2,'injection',$3,$4,$5) on conflict (task_id) do nothing`,
            [shortId(runId, artifact.artifact_id, "injection"), runId, parsed.merchantHint || null,
             { artifactId: artifact.artifact_id, sourcePath: artifact.source_path, patterns: guard.hits, modelReported: parsed.injectionDetected === true, note: parsed.injectionNote ?? null },
             { action: "quarantine_document", reason: "Instruction-like text in supplier content" }],
          );
          await emitEvent(db, { traceId, type: "rox.injection.blocked", severity: "WARN", payload: { artifactId: artifact.artifact_id, sourcePath: artifact.source_path } });
        }
      } catch (error) {
        counts.errors += 1;
        await db.query(
          `insert into rox_llm_calls (call_id, run_id, stage, model, ok, error) values (gen_random_uuid()::text,$1,'extract',$2,false,$3)`,
          [runId, MODELS.extract, String(error.message).slice(0, 500)],
        ).catch(() => {});
        if (error instanceof BudgetExceeded) { aborted = error; break; }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, work.length)) }, worker));
  await bumpStage(db, runId, "extract", counts);
  await emitEvent(db, { traceId, type: "rox.extract.completed", payload: counts });
  if (aborted) throw aborted;
  return counts;
}
