// Stage 4: entity resolution. "TF Embroidery", "Thread Forge Inc." and
// threadforge-eznglsyk all name one merchant, and a supplier writing about
// "the embroidery line" means one capability row.
//
// Deliberately blind: candidates come only from what the database already knows
// (merchant names, store domains, capability names), never from the corpus
// generator. Matching escalates exact -> trigram -> vector -> model, and stops
// at the first band that is decisive. Anything below the review threshold is
// queued for a human instead of merged.

import OpenAI from "openai";

import { ENTITY_THRESHOLDS, MODELS } from "./config.mjs";
import { shortId, meter, bumpStage, emitEvent } from "./db.mjs";

/** Strips the noise that never distinguishes two companies. */
export function normalizeAlias(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\.(myshopify\.com|ca|com|example)\b/g, " ")
    .replace(/\b(inc|ltd|llc|co|corp|company|limited|group|holdings)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Every string the database already associates with a merchant. */
async function merchantCandidates(db) {
  const { rows } = await db.query(
    `select m.merchant_id, m.name,
            coalesce(array_agg(distinct s.shopify_domain) filter (where s.shopify_domain is not null), '{}') as domains,
            coalesce(array_agg(distinct c.name) filter (where c.name is not null), '{}') as capability_names
       from merchants m
       left join merchant_stores s on s.merchant_id = m.merchant_id
       left join capabilities c on c.merchant_id = m.merchant_id
      where m.merchant_id <> 'm-unresolved'
      group by m.merchant_id, m.name`,
  );
  return rows.map((r) => ({
    merchantId: r.merchant_id,
    name: r.name,
    surfaces: [r.name, r.merchant_id, ...r.domains].filter(Boolean),
    capabilityNames: r.capability_names,
  }));
}

async function capabilityCandidates(db) {
  const { rows } = await db.query(
    `select capability_id, merchant_id, name, description from capabilities order by capability_id`,
  );
  return rows;
}

// ------------------------------------------------------------------ matchers

function exactMatch(alias, candidates) {
  const a = normalizeAlias(alias);
  if (!a) return null;
  for (const c of candidates) {
    for (const surface of c.surfaces) {
      const s = normalizeAlias(surface);
      if (s && (s === a || s.replace(/ /g, "") === a.replace(/ /g, ""))) {
        return { merchantId: c.merchantId, method: "exact", score: 1 };
      }
    }
  }
  return null;
}

/**
 * "Pack & Ship Logistics" contains every distinctive token of "Pack & Ship",
 * and "Needle N." is a prefix of "Needle North". Lexical containment catches
 * both without a model, and only counts tokens long enough to mean something.
 */
function containmentMatch(alias, candidates) {
  const aTokens = normalizeAlias(alias).split(" ").filter(Boolean);
  if (!aTokens.length) return null;
  let best = null;
  for (const c of candidates) {
    for (const surface of c.surfaces) {
      const sTokens = normalizeAlias(surface).split(" ").filter(Boolean);
      if (!sTokens.length) continue;
      const [short, long] =
        aTokens.length <= sTokens.length
          ? [aTokens, sTokens]
          : [sTokens, aTokens];
      const covered = short.filter((tok) =>
        long.some((other) =>
          tok.length >= 4
            ? other.startsWith(tok) || tok.startsWith(other)
            : other === tok,
        ),
      );
      if (covered.length !== short.length) continue;
      const distinctive = covered.some((tok) => tok.length >= 4);
      if (!distinctive) continue;
      const score = 0.8 + 0.15 * (short.length / long.length);
      if (!best || score > best.score)
        best = {
          merchantId: c.merchantId,
          method: "trgm",
          score,
          via: surface,
        };
    }
  }
  // Ambiguous containment ("Logo embroidery" matching three suppliers) is not a match.
  if (!best) return null;
  const rivals = new Set(
    candidates
      .filter((c) =>
        c.surfaces.some((s) => {
          const sTokens = normalizeAlias(s).split(" ").filter(Boolean);
          const [short, long] =
            aTokens.length <= sTokens.length
              ? [aTokens, sTokens]
              : [sTokens, aTokens];
          return (
            short.length > 0 &&
            short.every((tok) =>
              long.some((o) =>
                tok.length >= 4
                  ? o.startsWith(tok) || tok.startsWith(o)
                  : o === tok,
              ),
            )
          );
        }),
      )
      .map((c) => c.merchantId),
  );
  return rivals.size === 1 ? best : null;
}

/**
 * Who SENT the document: email domains and store handles. Document-wide by
 * nature - one sender per file - so it is safe to apply to every candidate in it.
 */
export function senderAliasesFromText(text) {
  const found = new Set();
  for (const m of String(text ?? "").matchAll(
    /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g,
  )) {
    const domain = m[1].toLowerCase();
    if (!/molecule|example\.com$|gmail|outlook/.test(domain)) found.add(domain);
  }
  for (const m of String(text ?? "").matchAll(
    /\b([a-z0-9-]+)\.myshopify\.com\b/gi,
  ))
    found.add(m[1].toLowerCase());
  return [...found];
}

/**
 * Our own capability identifiers, read from ONE candidate's evidence. A
 * warehouse export names a dozen of them in one file, so scanning the whole
 * document would attribute every row to whichever appeared first.
 */
export function capabilityIdsFrom(text) {
  return [
    ...new Set(
      [...String(text ?? "").matchAll(/\b(cap[-_][a-z0-9_-]+)\b/gi)].map((m) =>
        m[1].toLowerCase().replace(/_/g, "-"),
      ),
    ),
  ];
}

/** pg_trgm similarity, computed in the database so the index can be used later. */
async function trigramMatch(db, alias, candidates) {
  const surfaces = candidates.flatMap((c) =>
    c.surfaces.map((s) => ({ merchantId: c.merchantId, surface: s })),
  );
  const { rows } = await db.query(
    `select m.merchant_id, m.surface, similarity($1, m.surface) as sim
       from unnest($2::text[], $3::text[]) as m(merchant_id, surface)
      order by sim desc limit 3`,
    [
      normalizeAlias(alias),
      surfaces.map((s) => s.merchantId),
      surfaces.map((s) => normalizeAlias(s.surface)),
    ],
  );
  if (!rows.length || Number(rows[0].sim) === 0) return null;
  const best = rows[0];
  const runnerUp = rows.find((r) => r.merchant_id !== best.merchant_id);
  return {
    merchantId: best.merchant_id,
    method: "trgm",
    score: Number(best.sim),
    margin: Number(best.sim) - Number(runnerUp?.sim ?? 0),
    top: rows.map((r) => ({
      merchantId: r.merchant_id,
      surface: r.surface,
      sim: Number(r.sim),
    })),
  };
}

async function embed(client, db, runId, texts) {
  const started = Date.now();
  const res = await client.embeddings.create({
    model: MODELS.embed,
    input: texts,
  });
  await meter(db, runId, {
    stage: "link",
    model: MODELS.embed,
    usage: { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: 0 },
    latencyMs: Date.now() - started,
  });
  return res.data.map((d) => d.embedding);
}

/** Vector nearest neighbour over the alias index built from database surfaces. */
async function vectorMatch(db, client, runId, alias) {
  const [vec] = await embed(client, db, runId, [alias]);
  const { rows } = await db.query(
    `select resolved_id, alias, 1 - (embedding <=> $1::vector) as sim
       from rox_alias_embeddings where alias_kind = 'merchant'
      order by embedding <=> $1::vector limit 3`,
    [JSON.stringify(vec)],
  );
  if (!rows.length) return null;
  const best = rows[0];
  const runnerUp = rows.find((r) => r.resolved_id !== best.resolved_id);
  return {
    merchantId: best.resolved_id,
    method: "vector",
    score: Number(best.sim),
    margin: Number(best.sim) - Number(runnerUp?.sim ?? 0),
    top: rows.map((r) => ({
      merchantId: r.resolved_id,
      alias: r.alias,
      sim: Number(r.sim),
    })),
  };
}

/** Last resort, and only for the genuinely ambiguous band. */
async function llmMatch(client, db, runId, alias, shortlist) {
  const started = Date.now();
  const res = await client.responses.create({
    model: MODELS.adjudicate,
    instructions:
      "You decide whether a supplier name from a document refers to one of the known suppliers. " +
      "Answer with the merchantId only if a careful operations person would be confident. " +
      'If it is a plausible but unproven match, or the name could be a different company, answer "unknown". ' +
      "Never invent a merchantId that is not in the list.",
    input: JSON.stringify({
      aliasFromDocument: alias,
      knownSuppliers: shortlist,
    }),
    text: {
      format: {
        type: "json_schema",
        name: "entity_link",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["merchantId", "confidence", "reason"],
          properties: {
            merchantId: { type: "string" },
            confidence: { type: "number" },
            reason: { type: "string" },
          },
        },
      },
    },
    max_output_tokens: 500,
  });
  await meter(db, runId, {
    stage: "link",
    model: MODELS.adjudicate,
    usage: {
      input_tokens: res.usage?.input_tokens ?? 0,
      cached_tokens: res.usage?.input_tokens_details?.cached_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
    },
    latencyMs: Date.now() - started,
  });
  const parsed = JSON.parse(res.output_text ?? "{}");
  if (!parsed.merchantId || parsed.merchantId === "unknown") return null;
  return {
    merchantId: parsed.merchantId,
    method: "llm",
    score: Number(parsed.confidence ?? 0.6),
    reason: parsed.reason,
  };
}

// ------------------------------------------------------------------ capability

/** Within a merchant, pick the capability a phrase refers to. */
async function matchCapability(db, merchantId, subjectHint, fieldKind) {
  const { rows: caps } = await db.query(
    `select capability_id, name, description from capabilities where merchant_id = $1`,
    [merchantId],
  );
  if (!caps.length) return null;
  if (caps.length === 1)
    return { capabilityId: caps[0].capability_id, method: "only", score: 1 };

  const hint = normalizeAlias(subjectHint);
  // A document that quotes our own identifier is the easiest case.
  const direct = caps.find(
    (c) =>
      hint &&
      normalizeAlias(c.capability_id).replace(/ /g, "") ===
        hint.replace(/ /g, ""),
  );
  if (direct)
    return { capabilityId: direct.capability_id, method: "exact", score: 1 };
  if (!hint) return null;

  const { rows } = await db.query(
    `select c.capability_id, similarity($1, c.surface) as sim
       from unnest($2::text[], $3::text[]) as c(capability_id, surface)
      order by sim desc limit 2`,
    [
      hint,
      caps.map((c) => c.capability_id),
      caps.map((c) => normalizeAlias(`${c.name} ${c.description ?? ""}`)),
    ],
  );
  const best = rows[0];
  if (!best || Number(best.sim) < 0.25) return null;
  return {
    capabilityId: best.capability_id,
    method: "trgm",
    score: Number(best.sim),
  };
}

// ------------------------------------------------------------------ stage

/** Builds (or refreshes) the vector index of merchant surfaces. */
async function ensureAliasIndex(db, client, runId, candidates) {
  const surfaces = candidates.flatMap((c) =>
    c.surfaces.map((s) => ({ alias: s, resolved: c.merchantId })),
  );
  const { rows: have } = await db.query(
    `select alias from rox_alias_embeddings where alias_kind = 'merchant'`,
  );
  const known = new Set(have.map((r) => r.alias));
  const missing = surfaces.filter((s) => !known.has(s.alias));
  if (!missing.length) return 0;
  const vectors = await embed(
    client,
    db,
    runId,
    missing.map((m) => m.alias),
  );
  for (const [i, m] of missing.entries()) {
    await db.query(
      `insert into rox_alias_embeddings (alias, alias_kind, resolved_id, embedding, model)
       values ($1,'merchant',$2,$3,$4) on conflict (alias_kind, alias) do nothing`,
      [m.alias, m.resolved, JSON.stringify(vectors[i]), MODELS.embed],
    );
  }
  return missing.length;
}

/**
 * When no name resolves, the subject itself can identify the supplier - but
 * only when it points at exactly one capability in the whole network. "Logo
 * embroidery" names three suppliers and therefore identifies none.
 */
async function merchantFromCapability(db, texts) {
  const ids = [...new Set(texts.flatMap((x) => capabilityIdsFrom(x)))];
  if (!ids.length) return null;
  const { rows } = await db.query(
    `select capability_id, merchant_id from capabilities where lower(capability_id) = any($1::text[])`,
    [ids],
  );
  if (rows.length !== 1) return null; // ambiguous or unknown identifier
  return {
    merchantId: rows[0].merchant_id,
    capabilityId: rows[0].capability_id,
    method: "exact",
    score: 1,
  };
}

/**
 * The database itself holds duplicate suppliers: an early seed created
 * `m-basegoods` and `m-packship` alongside `base-goods` and `pack-ship`. They
 * are the same companies. Collapsing them is entity resolution applied to our
 * own records, and it has to happen before anything is attributed, or claims
 * about one supplier land on two rows.
 */
async function dedupeMerchants(db, runId) {
  const { rows } = await db.query(
    `select m.merchant_id, m.name, m.status,
            exists (select 1 from merchant_stores s where s.merchant_id = m.merchant_id) as has_store,
            (select count(*) from capabilities c where c.merchant_id = m.merchant_id)::int as caps
       from merchants m where m.merchant_id <> 'm-unresolved'`,
  );
  const groups = new Map();
  for (const r of rows) {
    const key = normalizeAlias(r.name).replace(/ /g, "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const map = new Map();
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    // The row that is actually trading wins: a store first, then online status.
    const canonical = [...members].sort(
      (a, b) =>
        Number(b.has_store) - Number(a.has_store) ||
        Number(b.status === "online") - Number(a.status === "online") ||
        b.caps - a.caps ||
        a.merchant_id.localeCompare(b.merchant_id),
    )[0];
    for (const m of members) {
      if (m.merchant_id === canonical.merchant_id) continue;
      map.set(m.merchant_id, canonical.merchant_id);
      await db.query(
        `insert into rox_entity_links (link_id, run_id, alias, alias_kind, resolved_id, method, score, status, evidence)
         values ($1,$2,$3,'merchant',$4,'exact',0.99,'linked',$5)
         on conflict (alias_kind, lower(alias)) do update set resolved_id = excluded.resolved_id, evidence = excluded.evidence`,
        [
          shortId("dedupe", m.merchant_id),
          runId,
          m.merchant_id,
          canonical.merchant_id,
          {
            reason: "duplicate merchant record in the database",
            duplicateOf: m.name,
            canonicalName: canonical.name,
          },
        ],
      );
    }
  }
  return map;
}

export async function link(db, { runId, batchId, traceId, limit = null }) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60_000,
    maxRetries: 2,
  });
  const counts = {
    extractions: 0,
    exact: 0,
    trgm: 0,
    vector: 0,
    llm: 0,
    needs_review: 0,
    unlinked: 0,
    capability_linked: 0,
    indexed: 0,
  };

  const duplicates = await dedupeMerchants(db, runId);
  counts.duplicates_merged = duplicates.size;

  // A duplicate's name and identifiers become surfaces of the canonical row, so
  // a document naming the old record still resolves to the live supplier.
  const raw = await merchantCandidates(db);
  const byId = new Map(raw.map((c) => [c.merchantId, c]));
  const candidates = [];
  for (const c of raw) {
    if (duplicates.has(c.merchantId)) continue;
    const absorbed = [...duplicates.entries()]
      .filter(([, canonical]) => canonical === c.merchantId)
      .map(([dup]) => byId.get(dup))
      .filter(Boolean);
    candidates.push({
      ...c,
      surfaces: [
        ...new Set([...c.surfaces, ...absorbed.flatMap((a) => a.surfaces)]),
      ],
    });
  }
  counts.indexed = await ensureAliasIndex(db, client, runId, candidates);

  const { rows: pending } = await db.query(
    `select x.extraction_id, x.merchant_hint, x.field, x.raw_value, a.source_path, a.content_text
       from rox_extractions x join raw_artifacts a using (artifact_id)
      where x.run_id = $1 and x.outcome = 'pending' and x.resolved_merchant_id is null
      order by x.extraction_id ${limit ? "limit " + Number(limit) : ""}`,
    [runId],
  );

  // One decision per distinct alias, reused across every extraction that carries it.
  const decided = new Map();

  /** exact -> containment -> trigram -> vector -> model, stopping when decisive. */
  async function resolveAlias(alias) {
    const key = alias.toLowerCase();
    if (decided.has(key)) return decided.get(key);

    let decision =
      exactMatch(alias, candidates) ?? containmentMatch(alias, candidates);
    let tri = null;
    let vec = null;
    if (!decision) {
      tri = await trigramMatch(db, alias, candidates);
      if (tri && tri.score >= 0.55 && tri.margin >= 0.1) decision = tri;
    }
    if (!decision) {
      vec = await vectorMatch(db, client, runId, alias);
      if (vec && vec.score >= 0.78 && vec.margin >= 0.03) decision = vec;
    }
    if (!decision && ((vec?.score ?? 0) >= 0.45 || (tri?.score ?? 0) >= 0.3)) {
      const top = [...(vec?.top ?? []), ...(tri?.top ?? [])];
      const shortlist = [...new Set(top.map((t) => t.merchantId))]
        .slice(0, 4)
        .map((mid) => ({
          merchantId: mid,
          name: candidates.find((c) => c.merchantId === mid)?.name,
          knownAs: candidates.find((c) => c.merchantId === mid)?.surfaces,
        }));
      decision = await llmMatch(client, db, runId, alias, shortlist);
      if (decision)
        decision.evidence = {
          shortlist,
          vector: vec?.score,
          trigram: tri?.score,
        };
    }

    await db.query(
      `insert into rox_entity_links (link_id, run_id, alias, alias_kind, resolved_id, method, score, status, evidence)
       values ($1,$2,$3,'merchant',$4,$5,$6,$7,$8)
       on conflict (alias_kind, lower(alias)) do update
         set resolved_id = excluded.resolved_id, method = excluded.method,
             score = excluded.score, status = excluded.status, evidence = excluded.evidence`,
      [
        shortId("link", alias),
        runId,
        alias,
        decision?.merchantId ?? null,
        decision?.method ?? "trgm",
        decision?.score ?? null,
        decision ? "linked" : "needs_review",
        decision?.evidence ?? {
          bestTrigram: tri?.score ?? null,
          bestVector: vec?.score ?? null,
          top: vec?.top ?? tri?.top ?? [],
        },
      ],
    );
    if (decision && duplicates.has(decision.merchantId))
      decision.merchantId = duplicates.get(decision.merchantId);
    decided.set(key, decision);
    return decision;
  }

  for (const row of pending) {
    counts.extractions += 1;
    const subjectHint = row.raw_value?.subjectHint ?? "";

    // Strongest signal first: one of our own capability identifiers quoted in
    // THIS candidate's evidence. That names the merchant and the capability at once.
    let decision = null;
    let capability = null;
    const viaCap = await merchantFromCapability(db, [
      subjectHint,
      row.evidence_text,
    ]);
    if (viaCap) {
      decision = {
        merchantId: duplicates.get(viaCap.merchantId) ?? viaCap.merchantId,
        method: viaCap.method,
        score: viaCap.score,
      };
      capability = {
        capabilityId: viaCap.capabilityId,
        method: viaCap.method,
        score: viaCap.score,
      };
      counts.via_capability = (counts.via_capability ?? 0) + 1;
    }

    // Otherwise the supplier's name, then who sent the document.
    const aliases = [
      row.merchant_hint?.trim(),
      ...senderAliasesFromText(row.content_text),
    ].filter(Boolean);
    if (!decision) {
      for (const alias of aliases) {
        decision = await resolveAlias(alias);
        if (decision) break;
      }
    }

    if (!decision) {
      counts.unlinked += 1;
      if (aliases.length) {
        counts.needs_review += 1;
        await db.query(
          `insert into rox_review_queue (task_id, run_id, kind, merchant_hint, detail, proposed_action)
           values ($1,$2,'low_confidence_link',$3,$4,$5) on conflict (task_id) do nothing`,
          [
            shortId(runId, "link", aliases[0]),
            runId,
            aliases[0],
            { aliases, sourcePath: row.source_path, subjectHint },
            { action: "ask_human_to_map_alias", alias: aliases[0] },
          ],
        );
      }
      continue;
    }
    counts[decision.method] = (counts[decision.method] ?? 0) + 1;

    const cap =
      capability ??
      (await matchCapability(db, decision.merchantId, subjectHint, row.field));
    if (cap && duplicates.has(decision.merchantId))
      decision.merchantId = duplicates.get(decision.merchantId);
    if (cap) counts.capability_linked += 1;
    await db.query(
      `update rox_extractions
          set resolved_merchant_id = $2, resolved_capability_id = $3::text, link_method = $4, link_score = $5,
              resolved_field = case when $3::text is null then null else $3::text || '.' || field end
        where extraction_id = $1`,
      [
        row.extraction_id,
        decision.merchantId,
        cap?.capabilityId ?? null,
        decision.method,
        decision.score ?? null,
      ],
    );
  }

  await bumpStage(db, runId, "link", counts);
  await emitEvent(db, { traceId, type: "rox.link.completed", payload: counts });
  return counts;
}
