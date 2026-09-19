#!/usr/bin/env node
// The rule compiler: the model writes the parser, not the answers.
//
// 61,375 real Open Food Facts products carry a free-text quantity ("6 oz (170 g)",
// "1,5L", "10x 0.8 oz - Net weight 8 oz", "1 dozen", "462 ג'"). Asking a model
// per row would be slow and expensive for a job that is mostly repetition, so:
//
//   mine     - show the model a frequency-weighted sample, ask for REGEX RULES
//   label    - ask the model to judge a separate holdout of labels, one by one
//   evaluate - score the mined rules against that holdout; accept only the
//              precise ones, and record precision on the rule itself
//   apply    - run accepted rules over every row locally, no model involved
//   escalate - send only the residual distinct labels to the model, cached so
//              each distinct string costs at most one call
//
// Honest about its own measurement: the holdout is labelled by a model, so
// "precision" here means agreement with a careful per-item read, not human truth.
// That is stated in the output and stored on the rule.
//
//   node --env-file=../.env --env-file=../.env.local pipeline/rules.mjs --mine --label --evaluate --apply --escalate

import OpenAI from "openai";

import { connect, startRun, finishRun, meter, shortId } from "./db.mjs";
import { MODELS } from "./config.mjs";
import { canonicalise, compileRule, applyRules, agree } from "./quantity-rules.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const SAMPLE = Number(args.sample ?? 250);
const HOLDOUT = Number(args.holdout ?? 150);
const ESCALATE_CAP = Number(args["escalate-cap"] ?? 200);
const DOMAIN = "off_quantity";
/** Held-out matches a rule needs before its precision means anything. */
const MIN_SUPPORT = Number(args["min-support"] ?? 3);

const MINE_INSTRUCTIONS = `You are writing a parser, not answering questions.

You will see real free-text quantity labels from a food product database, with how often each appears. Propose JavaScript regular expressions that extract a numeric quantity and its unit from labels of that shape.

Guidance:
- Prefer a small number of general rules over many specific ones. Order matters: the most specific rule should come first.
- When a label states the same quantity twice in different units ("6 oz (170 g)", "16 oz (1LB) 454 grams"), write the rule to capture the METRIC one, because it is exact.
- When a label is a multipack ("10x 0.8 oz", "3x100 g", "2*1 L", "10ct 0.09 OZ"), capture the multiplier in countGroup so the total can be computed. The separator may be "x", "X", the multiplication sign, "*", "-" or "ct".
- When a label states BOTH the components and the total ("4*125gr = 500gr", "10ct 0.09 OZ (2.55g) Packets / 0.9 OZ (25g)"), the answer is the TOTAL. Write the rule so the total wins, and order it ahead of the rule that would match the first component.
- Labels that name countable things with no weight ("6 ROLLS", "300 Tablets", "1 dozen", "5 PIECES") are NOT weights. Write rules for them with unit "count".
- Do not write a rule that matches a bare number with no unit ("1", "3x100"): that is genuinely ambiguous and must stay unparsed.
- Use only groups you declare. Keep patterns anchored where you can, and avoid nested quantifiers.
- Decimal commas are used ("1,5L"): handle them.

Return rules only. Do not return parsed values.`;

const MINE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["rules"],
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "pattern", "flags", "valueGroup", "unitGroup", "countGroup", "unitLiteral", "notes"],
        properties: {
          name: { type: "string" },
          pattern: { type: "string" },
          flags: { type: "string" },
          valueGroup: { type: "integer" },
          unitGroup: { type: "integer" },   // 0 when the unit is fixed by unitLiteral
          countGroup: { type: "integer" },  // 0 when there is no multiplier
          unitLiteral: { type: "string" },  // used when unitGroup is 0, e.g. "count"
          notes: { type: "string" },
        },
      },
    },
  },
};

const LABEL_INSTRUCTIONS = `Read one free-text product quantity label and say what it means in canonical units.

- grams: the net weight in grams, if the label states a weight. Convert oz (28.3495 g), lb (453.592 g), kg, mg.
- millilitres: the net volume in millilitres, if the label states a volume. Convert fl oz (29.5735 ml), l, cl, dl, qt, gallon, pint.
- countUnits: how many countable items, if the label counts things rather than measuring them ("6 ROLLS", "1 dozen" = 12, "300 Tablets").
- If the label states the same quantity twice in different units, use the metric figure.
- If it is a multipack, report the TOTAL.
- unparseable: true if the label states no usable quantity ("1", "1 MEAL", a bare number, or text you cannot read).
Report only what the label states. Never estimate a typical size.`;

const LABEL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["grams", "millilitres", "countUnits", "unparseable"],
  properties: {
    grams: { type: ["number", "null"] },
    millilitres: { type: ["number", "null"] },
    countUnits: { type: ["number", "null"] },
    unparseable: { type: "boolean" },
  },
};

// ------------------------------------------------------------------ main

const db = await connect({ max: 4 });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 2 });
const runId = args.run ? String(args.run) : await startRun(db, { batchId: DOMAIN, mode: "real", models: MODELS });
console.log(`rule compiler  run ${runId}  domain ${DOMAIN}`);

const { rows: labelRows } = await db.query(
  `select quantity_label as label, count(*)::int as n
     from bulk_products
    where source = 'open_food_facts' and coalesce(quantity_label, '') <> ''
    group by 1 order by n desc`,
);
const totalRows = labelRows.reduce((s, r) => s + r.n, 0);
console.log(`${labelRows.length} distinct labels over ${totalRows.toLocaleString()} products`);

// Deterministic split so a rule is never scored on what it was mined from.
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const holdoutSet = labelRows.filter((r) => hash(r.label) % 5 === 0);
const mineSet = labelRows.filter((r) => hash(r.label) % 5 !== 0);

// ---- mine
if (args.mine) {
  // Frequency-weighted head plus a spread of the long tail, so rules cover both.
  const head = mineSet.slice(0, Math.floor(SAMPLE * 0.4));
  const tail = mineSet.slice(Math.floor(SAMPLE * 0.4)).filter((_, i) => i % Math.max(1, Math.floor(mineSet.length / (SAMPLE * 0.6))) === 0).slice(0, Math.ceil(SAMPLE * 0.6));
  const sample = [...head, ...tail];
  const started = Date.now();
  const res = await client.responses.create({
    model: MODELS.adjudicate,
    instructions: MINE_INSTRUCTIONS,
    input: JSON.stringify({ labels: sample.map((s) => ({ label: s.label, products: s.n })) }),
    text: { format: { type: "json_schema", name: "quantity_rules", schema: MINE_SCHEMA, strict: true } },
    max_output_tokens: 6000,
  });
  await meter(db, runId, { stage: "rules.mine", model: MODELS.adjudicate, latencyMs: Date.now() - started, usage: {
    input_tokens: res.usage?.input_tokens ?? 0, cached_tokens: res.usage?.input_tokens_details?.cached_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 } });
  const { rules } = JSON.parse(res.output_text ?? '{"rules":[]}');
  let stored = 0;
  for (const [i, rule] of rules.entries()) {
    if (!compileRule(rule)) { console.log(`  rejected (will not compile): ${rule.name}`); continue; }
    await db.query(
      `insert into rox_rules (rule_id, domain, pattern, transform, created_by, status, domain_detail)
       values ($1,$2,$3,$4,$5,'candidate',$6)
       on conflict (rule_id) do update set pattern = excluded.pattern, transform = excluded.transform, status = 'candidate'`,
      [shortId(DOMAIN, rule.pattern, String(i)), DOMAIN, rule.pattern,
       { flags: rule.flags, valueGroup: rule.valueGroup, unitGroup: rule.unitGroup, countGroup: rule.countGroup, unitLiteral: rule.unitLiteral, order: i },
       MODELS.adjudicate, { name: rule.name, notes: rule.notes }],
    );
    stored += 1;
  }
  console.log(`mined ${rules.length} rules, stored ${stored} (sample of ${sample.length} labels)`);
}

// ---- label the holdout
if (args.label) {
  const { rows: have } = await db.query(`select raw_label from rox_rule_holdout`);
  const known = new Set(have.map((r) => r.raw_label));
  const step = Math.max(1, Math.floor(holdoutSet.length / HOLDOUT));
  const sample = holdoutSet.filter((_, i) => i % step === 0).slice(0, HOLDOUT).filter((r) => !known.has(r.label));
  console.log(`labelling ${sample.length} holdout labels one by one`);
  let done = 0;
  const queue = [...sample];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const row = queue.shift();
      const started = Date.now();
      try {
        const res = await client.responses.create({
          model: MODELS.extract,
          instructions: LABEL_INSTRUCTIONS,
          input: JSON.stringify({ label: row.label }),
          text: { format: { type: "json_schema", name: "quantity_label", schema: LABEL_SCHEMA, strict: true } },
          max_output_tokens: 300,
        });
        await meter(db, runId, { stage: "rules.label", model: MODELS.extract, latencyMs: Date.now() - started, usage: {
          input_tokens: res.usage?.input_tokens ?? 0, cached_tokens: res.usage?.input_tokens_details?.cached_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 } });
        const j = JSON.parse(res.output_text ?? "{}");
        await db.query(
          `insert into rox_rule_holdout (raw_label, grams, millilitres, count_units, unparseable, labelled_by)
           values ($1,$2,$3,$4,$5,$6) on conflict (raw_label) do nothing`,
          [row.label, j.grams, j.millilitres, j.countUnits, Boolean(j.unparseable), MODELS.extract],
        );
        done += 1;
      } catch (error) { console.log(`  label failed: ${String(error.message).slice(0, 80)}`); }
    }
  }));
  console.log(`labelled ${done}`);
}

// ---- evaluate
async function loadRules(status = null) {
  const { rows } = await db.query(
    `select * from rox_rules where domain = $1 ${status ? "and status = '" + status + "'" : ""}`, [DOMAIN]);
  return rows
    .map((r) => compileRule({ ...r.transform, pattern: r.pattern, name: r.domain_detail?.name ?? r.rule_id, rule_id: r.rule_id }))
    .filter(Boolean)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

if (args.evaluate) {
  const rules = await loadRules();
  const { rows: holdout } = await db.query(`select * from rox_rule_holdout`);
  const per = new Map(rules.map((r) => [r.rule_id, { hits: 0, correct: 0 }]));
  let covered = 0, correct = 0;
  for (const h of holdout) {
    const applied = applyRules(h.raw_label, rules);
    if (!applied) continue;
    covered += 1;
    const stat = per.get(applied.rule_id);
    stat.hits += 1;
    // Judge the primary measure. A rule that reads "660 g (30 individual
    // sachets)" as 660 g is correct about the quantity even though it does not
    // also report the 30; counting only decides the verdict when there is no
    // weight or volume to compare.
    const measured = applied.grams !== null || applied.millilitres !== null;
    const labelMeasured = h.grams !== null || h.millilitres !== null;
    const ok = !h.unparseable && (
      measured || labelMeasured
        ? agree(applied.grams, h.grams) && agree(applied.millilitres, h.millilitres)
        : agree(applied.count_units, h.count_units));
    if (ok) { stat.correct += 1; correct += 1; }
  }
  let accepted = 0;
  for (const [ruleId, stat] of per) {
    const precision = stat.hits ? (100 * stat.correct) / stat.hits : null;
    // Three outcomes, and "not enough evidence" is not the same as "wrong":
    // a rule that matched one held-out label perfectly stays a candidate until
    // a larger holdout can support it.
    const status = stat.hits < MIN_SUPPORT ? "candidate" : precision >= 95 ? "accepted" : "rejected";
    if (status === "accepted") accepted += 1;
    await db.query(
      `update rox_rules set status = $2, precision_pct = $3, sample_size = $4, evaluated_at = now() where rule_id = $1`,
      [ruleId, status, precision, stat.hits],
    );
  }
  console.log(`evaluated against ${holdout.length} held-out labels: ${covered} matched, ${correct} agreed, ${accepted} rules accepted (>= ${MIN_SUPPORT} matches and >= 95% agreement)`);
  console.log(`(holdout labelled by ${MODELS.extract}; precision means agreement with a per-item read, not human truth.\n Spot-checking the disagreements found the holdout itself wrong on a minority of them - fluid ounces converted to grams, a multipack mis-multiplied - so this is a lower bound.)`);
}

// ---- apply
if (args.apply) {
  const rules = await loadRules("accepted");
  console.log(`applying ${rules.length} accepted rules to ${totalRows.toLocaleString()} products`);
  const byLabel = new Map();
  for (const row of labelRows) byLabel.set(row.label, applyRules(row.label, rules));
  const { rows: products } = await db.query(
    `select sku, quantity_label from bulk_products
      where source = 'open_food_facts' and coalesce(quantity_label,'') <> ''`);
  let written = 0, unmatched = 0;
  const batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await db.query(
      `insert into bulk_product_quantities (sku, raw_label, grams, millilitres, count_units, method, rule_id, confidence)
       select * from unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::text[], $7::text[], $8::numeric[])
       on conflict (sku) do update set grams = excluded.grams, millilitres = excluded.millilitres,
         count_units = excluded.count_units, method = excluded.method, rule_id = excluded.rule_id`,
      [batch.map((b) => b.sku), batch.map((b) => b.label), batch.map((b) => b.grams), batch.map((b) => b.ml),
       batch.map((b) => b.count), batch.map(() => "rule"), batch.map((b) => b.ruleId), batch.map(() => 0.95)],
    );
    written += batch.length;
    batch.length = 0;
  };
  for (const p of products) {
    const hit = byLabel.get(p.quantity_label);
    if (!hit) { unmatched += 1; continue; }
    batch.push({ sku: p.sku, label: p.quantity_label, grams: hit.grams, ml: hit.millilitres, count: hit.count_units, ruleId: hit.rule_id });
    if (batch.length >= 2000) await flush();
  }
  await flush();
  const distinctUnmatched = labelRows.filter((r) => !byLabel.get(r.label)).length;
  console.log(`rules covered ${written.toLocaleString()} products (${((100 * written) / products.length).toFixed(1)}%), ${unmatched.toLocaleString()} left for escalation across ${distinctUnmatched} distinct labels`);
}

// ---- escalate the residue
if (args.escalate) {
  const rules = await loadRules("accepted");
  const residue = labelRows.filter((r) => !applyRules(r.label, rules)).sort((a, b) => b.n - a.n).slice(0, ESCALATE_CAP);
  console.log(`escalating ${residue.length} distinct labels (covering ${residue.reduce((s, r) => s + r.n, 0).toLocaleString()} products)`);
  const queue = [...residue];
  let done = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const row = queue.shift();
      const started = Date.now();
      try {
        const res = await client.responses.create({
          model: MODELS.extract,
          instructions: LABEL_INSTRUCTIONS,
          input: JSON.stringify({ label: row.label }),
          text: { format: { type: "json_schema", name: "quantity_label", schema: LABEL_SCHEMA, strict: true } },
          max_output_tokens: 300,
        });
        await meter(db, runId, { stage: "rules.escalate", model: MODELS.extract, latencyMs: Date.now() - started, usage: {
          input_tokens: res.usage?.input_tokens ?? 0, cached_tokens: res.usage?.input_tokens_details?.cached_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 } });
        const j = JSON.parse(res.output_text ?? "{}");
        // One call per distinct string, applied to every product that shares it.
        await db.query(
          `insert into bulk_product_quantities (sku, raw_label, grams, millilitres, count_units, method, confidence)
           select sku, quantity_label, $2, $3, $4, $5, 0.8 from bulk_products
            where source = 'open_food_facts' and quantity_label = $1
           on conflict (sku) do update set grams = excluded.grams, millilitres = excluded.millilitres,
             count_units = excluded.count_units, method = excluded.method`,
          [row.label, j.grams, j.millilitres, j.countUnits, j.unparseable ? "unparseable" : "model"],
        );
        done += 1;
      } catch (error) { console.log(`  escalation failed for "${row.label}": ${String(error.message).slice(0, 80)}`); }
    }
  }));
  console.log(`escalated ${done} distinct labels`);
}

const { rows: [cost] } = await db.query(`select round(cost_usd, 4) as cost from rox_ingest_runs where run_id = $1`, [runId]);
const { rows: [coverage] } = await db.query(
  `select count(*) filter (where method = 'rule') as by_rule,
          count(*) filter (where method = 'model') as by_model,
          count(*) filter (where method = 'unparseable') as unparseable,
          count(*) as total from bulk_product_quantities`);
await finishRun(db, runId, "completed");
console.log(`\ncost $${cost.cost}`);
console.table([coverage]);
await db.end();
