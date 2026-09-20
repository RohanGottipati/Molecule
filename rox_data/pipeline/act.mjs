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
import { decideAvailability } from "./availability.mjs";
import { shortId, meter, bumpStage, emitEvent } from "./db.mjs";

// `canonical_resolutions.scores` has two writers with two shapes: this pipeline
// stores a bare array of scored claims, while services/reality stores
// {"claims": [{claimId, score, recencyScore}]} - ids only, no values. Read both,
// and hydrate the thin shape from canonical_claims so a draft can cite figures.
function scoreRows(scores) {
  if (Array.isArray(scores)) return scores;
  if (scores && Array.isArray(scores.claims)) return scores.claims;
  return [];
}

async function hydrateScores(db, rows) {
  const needed = new Set();
  for (const row of rows) {
    for (const s of scoreRows(row.scores)) {
      if (s.value === undefined && s.claimId) needed.add(s.claimId);
    }
  }
  if (!needed.size) return new Map();
  const { rows: claims } = await db.query(
    `select claim_id, normalized_value, normalized_unit, source_kind, source_reference, observed_at
       from canonical_claims where claim_id = any($1::text[])`,
    [[...needed]],
  );
  return new Map(claims.map((c) => [c.claim_id, c]));
}

const DRAFT_INSTRUCTIONS = `You write a short, plain, professional email from an operations team to a supplier, asking them to confirm one operational fact.

Rules:
- Six sentences at most. No greetings beyond "Hi <name>," and no marketing tone.
- State precisely what we have on record and where each figure came from, including when it was said.
- Ask them to confirm which is current. Do not propose a value yourself, do not guess, and do not imply they made a mistake.
- If the figures came from different dates, say so.
- Return the subject in the subject field, never inside the body: six words or fewer, naming the supplier's capability and the fact in question.
- The body is plain text and starts at the greeting. No "Subject:" line inside it, and no signature block - the system adds the signature.`;

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: {
    subject: {
      type: "string",
      description: "Non-empty email subject, six words or fewer.",
    },
    body: {
      type: "string",
      description:
        "Email body starting at the greeting, with no Subject: line.",
    },
  },
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
    max_output_tokens: 2500,
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
  // A reasoning model spends part of max_output_tokens on reasoning, so a long
  // conflict can truncate the JSON mid-string. A missing draft is recoverable -
  // the review row still carries the evidence - but a thrown parse error would
  // abandon every conflict after it.
  if (res.status === "incomplete" || !res.output_text) return null;
  try {
    return JSON.parse(res.output_text);
  } catch {
    console.warn(
      `  act: draft for ${context.supplier}/${context.fact} came back unparseable; queued without a draft`,
    );
    return null;
  }
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

  const hydrated = await hydrateScores(db, open);

  for (const row of open) {
    counts.conflicts += 1;
    if (row.status === "unknown") counts.unknown_fields += 1;
    const sources = scoreRows(row.scores)
      .map((s) => {
        const c = s.value === undefined ? hydrated.get(s.claimId) : null;
        return {
          value: s.value ?? c?.normalized_value ?? null,
          unit: s.unit ?? c?.normalized_unit ?? null,
          saidBy: s.source ?? c?.source_kind ?? null,
          reference: s.reference ?? c?.source_reference ?? null,
          observed: s.observedAt ?? c?.observed_at ?? null,
          score: s.score,
        };
      })
      .filter((s) => s.value !== null);
    // The top few by score are what the supplier needs to reconcile; citing 27
    // sources makes an unreadable email and a prompt long enough to truncate.
    const cited = [...sources]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 8);
    let draft = null;
    if (!dry) {
      draft = await draftFollowUp(client, db, runId, {
        supplier: row.merchant_name,
        fact: row.field,
        status: row.status,
        whatWeHaveOnRecord: cited,
        whyWeAreAsking: row.explanation,
      });
      if (draft) counts.drafted += 1;
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

  // 3. A resolved capacity is compared with the job (Order 5). Only a fact we
  //    are sure of can exclude a supplier and propose a replan; anything
  //    uncertain becomes a question. Nothing here executes: the queue row is a
  //    proposal, and approval is what a bridge to the orchestrator waits for.
  const job = {
    units: Number(process.env.ROX_JOB_UNITS ?? 200),
    windowHours: Number(process.env.ROX_JOB_WINDOW_HOURS ?? 72),
  };
  counts.replans_proposed = 0;
  counts.availability_blocked = 0;
  const { rows: capacities } = await db.query(
    `select r.merchant_id, r.field, r.status, r.value, r.winning_claim_id,
            c.normalized_unit, c.observed_at
       from canonical_resolutions r
       left join canonical_claims c on c.claim_id = r.winning_claim_id
      where r.field like '%.capacity'`,
  );
  for (const row of capacities) {
    const capabilityId = row.field.split(".")[0];
    const decision = decideAvailability({
      subject: { merchantId: row.merchant_id, capabilityId },
      job,
      resolution: {
        status: row.status,
        value: row.value,
        unit: row.normalized_unit ?? undefined,
        observedAt: row.observed_at?.toISOString?.() ?? row.observed_at,
        claimId: row.winning_claim_id ?? undefined,
      },
      now: new Date(),
    });
    if (decision.decision === "eligible") continue;
    // Unknown and conflicted facts already have a drafted question (step 1).
    if (["unknown", "conflicted"].includes(decision.code)) continue;
    if (decision.decision === "excluded") counts.replans_proposed += 1;
    else counts.availability_blocked += 1;
    await db.query(
      `insert into rox_review_queue (task_id, run_id, kind, merchant_id, field, detail, proposed_action, status)
       values ($1,$2,'missing_fact',$3,$4,$5,$6,'open')
       on conflict (task_id) do update set detail = excluded.detail, proposed_action = excluded.proposed_action`,
      [
        decision.actionKey,
        runId,
        row.merchant_id,
        row.field,
        {
          decision: decision.decision,
          code: decision.code,
          reason: decision.reason,
          job,
          evidence: decision.evidence ?? null,
          claimId: row.winning_claim_id,
        },
        {
          action: decision.action,
          actionKey: decision.actionKey,
          merchantId: row.merchant_id,
          capabilityId,
          requiresApproval: true,
        },
      ],
    );
  }

  await bumpStage(db, runId, "act", counts);
  await emitEvent(db, { traceId, type: "rox.act.completed", payload: counts });
  return counts;
}
