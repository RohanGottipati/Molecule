// Stage 7: acting on what was decided.
//
// Three kinds of action, in order of how much they presume:
//   1. A conflicted or unknown field becomes a question for the supplier - the
//      agent drafts the email, citing exactly what disagreed, and queues it.
//   2. A resolved value that differs from what the capability row says becomes a
//      proposed write-back to Shopify Admin.
//   3. Nothing is sent or written without --apply. Drafting is not sending.

import OpenAI from "openai";

import { MODELS } from "./config.mjs";
import { shortId, meter, bumpStage, emitEvent } from "./db.mjs";

const DRAFT_INSTRUCTIONS = `You write a short, plain, professional email from an operations team to a supplier, asking them to confirm one operational fact.

Rules:
- Six sentences at most. No greetings beyond "Hi <name>," and no marketing tone.
- State precisely what we have on record and where each figure came from, including when it was said.
- Ask them to confirm which is current. Do not propose a value yourself, do not guess, and do not imply they made a mistake.
- If the figures came from different dates, say so.
- Plain text. No subject line, no signature block - those are added by the system.`;

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: { subject: { type: "string" }, body: { type: "string" } },
};

async function draftFollowUp(client, db, runId, context) {
  const started = Date.now();
  const res = await client.responses.create({
    model: MODELS.adjudicate,
    instructions: DRAFT_INSTRUCTIONS,
    input: JSON.stringify(context),
    text: {
      format: {
        type: "json_schema",
        name: "supplier_followup",
        schema: DRAFT_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 800,
  });
  await meter(db, runId, {
    stage: "act",
    model: MODELS.adjudicate,
    usage: {
      input_tokens: res.usage?.input_tokens ?? 0,
      cached_tokens: res.usage?.input_tokens_details?.cached_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
    },
    latencyMs: Date.now() - started,
  });
  return JSON.parse(res.output_text ?? "{}");
}

export async function act(db, { runId, traceId, dry = false, apply = false }) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60_000,
    maxRetries: 2,
  });
  const counts = {
    conflicts: 0,
    drafted: 0,
    writebacks_proposed: 0,
    writebacks_applied: 0,
    unknown_fields: 0,
  };

  // 1. Conflicts and unknowns become questions, with the evidence attached.
  const { rows: open } = await db.query(
    `select r.merchant_id, r.field, r.status, r.explanation, r.scores, m.name as merchant_name
       from canonical_resolutions r join merchants m using (merchant_id)
      where r.status in ('conflicted', 'unknown')
        and not exists (
          select 1 from rox_review_queue q
           where q.merchant_id = r.merchant_id and q.field = r.field
             and q.kind = 'conflict' and q.status = 'open')`,
  );

  for (const row of open) {
    counts.conflicts += 1;
    if (row.status === "unknown") counts.unknown_fields += 1;
    const sources = (row.scores ?? []).map((s) => ({
      value: s.value,
      unit: s.unit,
      saidBy: s.source,
      reference: s.reference,
      observed: s.observedAt ?? null,
      score: s.score,
    }));
    let draft = null;
    if (!dry) {
      draft = await draftFollowUp(client, db, runId, {
        supplier: row.merchant_name,
        fact: row.field,
        status: row.status,
        whatWeHaveOnRecord: sources,
        whyWeAreAsking: row.explanation,
      });
      counts.drafted += 1;
    }
    await db.query(
      `insert into rox_review_queue (task_id, run_id, kind, merchant_id, field, detail, proposed_action, draft_message)
       values ($1,$2,'conflict',$3,$4,$5,$6,$7)
       on conflict (task_id) do update set detail = excluded.detail, draft_message = excluded.draft_message`,
      [
        shortId(runId, "conflict", row.merchant_id, row.field),
        runId,
        row.merchant_id,
        row.field,
        { status: row.status, explanation: row.explanation, sources },
        {
          action: "email_supplier",
          subject: draft?.subject ?? null,
          requiresApproval: true,
        },
        draft ? `Subject: ${draft.subject}\n\n${draft.body}` : null,
      ],
    );
    await emitEvent(db, {
      traceId,
      type: "rox.review.queued",
      severity: "WARN",
      merchantId: row.merchant_id,
      payload: { field: row.field, status: row.status },
    });
  }

  // 2. A resolved value that disagrees with the capability row is a write-back.
  const { rows: drift } = await db.query(
    `select r.merchant_id, r.field, r.value, r.winning_claim_id, c.capability_id,
            c.capability_json->'capacity'->>'available' as current_available,
            c.capability_json->'leadTime'->>'max' as current_lead_max
       from canonical_resolutions r
       join capabilities c on c.capability_id = split_part(r.field, '.', 1)
      where r.status = 'resolved'`,
  );
  for (const row of drift) {
    const kind = row.field.split(".").slice(1).join(".");
    const current =
      kind === "capacity"
        ? Number(row.current_available)
        : kind === "lead_time_hours"
          ? Number(row.current_lead_max)
          : null;
    const next = Number(row.value);
    if (
      current === null ||
      Number.isNaN(current) ||
      Number.isNaN(next) ||
      current === next
    )
      continue;
    counts.writebacks_proposed += 1;
    await db.query(
      `insert into rox_review_queue (task_id, run_id, kind, merchant_id, field, detail, proposed_action, status)
       values ($1,$2,'missing_fact',$3,$4,$5,$6,'open')
       on conflict (task_id) do update set detail = excluded.detail, proposed_action = excluded.proposed_action`,
      [
        shortId(runId, "writeback", row.merchant_id, row.field),
        runId,
        row.merchant_id,
        row.field,
        {
          capabilityId: row.capability_id,
          current,
          resolved: next,
          claimId: row.winning_claim_id,
        },
        {
          action: "shopify_metafield_writeback",
          namespace: "molecule",
          fields: {
            resolved_value: next,
            claim_status: "resolved",
            resolution_source: row.winning_claim_id,
          },
          note: "scripts/shopify-writeback.mjs applies this",
          requiresApproval: !apply,
        },
      ],
    );
  }

  await bumpStage(db, runId, "act", counts);
  await emitEvent(db, { traceId, type: "rox.act.completed", payload: counts });
  return counts;
}
