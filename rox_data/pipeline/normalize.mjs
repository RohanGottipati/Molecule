// Stage 5: normalization. No model runs here, on purpose - this is where the
// pipeline is allowed to say no. A value that does not parse cleanly, or a unit
// we have not defined, is quarantined with a reason. Nothing is rounded into
// shape and nothing is guessed.

import {
  SOURCE_AUTHORITY,
  FIELD_REGISTRY,
  FX_TO_CAD,
  BUSINESS_DAY_HOURS,
  CALENDAR_DAY_HOURS,
} from "./config.mjs";

const WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  hundred: 100,
  thousand: 1000,
};

/**
 * Parses a number the way a document writes it. Returns null for anything it
 * cannot read with certainty - including OCR damage like "4l.8O", which looks
 * numeric but is not.
 */
export function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // Words: "four hundred", "a thousand", "zero".
  const words = s
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (
    words.length &&
    words.every((w) => w in WORDS || w === "a" || w === "and")
  ) {
    let total = 0,
      current = 0;
    for (const w of words) {
      if (w === "a") {
        current = current || 1;
        continue;
      }
      if (w === "and") continue;
      const v = WORDS[w];
      if (v === 100 || v === 1000) current = (current || 1) * v;
      else current += v;
    }
    total += current;
    return Number.isFinite(total) ? total : null;
  }

  s = s
    .replace(/[$€£]/g, "")
    .replace(/\b(cad|usd|gbp|eur)\b/g, "")
    .trim();
  s = s.replace(
    /^(about|approx\.?|approximately|around|under|over|up to|~)\s*/i,
    "",
  );
  s = s.replace(/,(?=\d{3}\b)/g, ""); // thousands separators
  s = s.replace(/(\d),(\d)/g, "$1.$2"); // European decimal comma
  s = s
    .replace(
      /\s*(units?|pcs?|pieces?|ea|each|kits?|hoodies|bottles|packs?)\b.*$/i,
      "",
    )
    .trim();
  s = s
    .replace(/\s*(\/|per\s+)?(day|week|month|hour|hours|h)\b.*$/i, "")
    .trim();

  // Anything left that is not a plain number is not a number we will accept.
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Which period a capacity figure is expressed in, from whatever the document said. */
export function detectPeriod(unitText, periodHint, rawText) {
  const explicit = String(periodHint ?? "").trim();
  const unit = String(unitText ?? "").trim();
  const hinted = capacityPeriod(explicit);
  const stated = capacityPeriod(unit);
  if (explicit && !hinted) return null;
  if (unit && !stated && !/^(units?|pcs?|pieces?|kits?)$/i.test(unit))
    return null;
  if (hinted && stated && hinted !== stated) return null;
  return hinted ?? stated ?? capacityPeriod(rawText);
}

export function detectCurrency(unitText, rawText) {
  const text = String(unitText ?? "").trim() || String(rawText ?? "").trim();
  const match =
    /^(CAD|USD|GBP|EUR|£|€)(?:\s*(?:\/|per\s+)(?:units?|items?|each|ea))?$/i.exec(
      text,
    );
  if (!match) return null;
  return match[1] === "£"
    ? "GBP"
    : match[1] === "€"
      ? "EUR"
      : match[1].toUpperCase();
}

function capacityPeriod(text) {
  const unit = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(
      /^(?:units?|pcs?|pieces?|kits?|hoodies|bottles|packs?)\s*(?:\/|per\s+)\s*/,
      "",
    )
    .replace(/^per\s+|^\//, "");
  if (/^(?:d|days?|daily)$/.test(unit)) return "day";
  if (/^(?:wk|weeks?|weekly)$/.test(unit)) return "week";
  if (/^(?:mo|months?|monthly)$/.test(unit)) return "month";
  return null;
}

function durationUnit(text) {
  const unit = String(text ?? "")
    .trim()
    .toLowerCase();
  if (/^(?:h|hours?|hrs?)$/.test(unit)) return "hours";
  if (/^(?:business|working)\s+days?$/.test(unit)) return "business_days";
  if (/^(?:calendar\s+)?days?$/.test(unit)) return "days";
  return null;
}

// Evidence fallback accepts one amount with an adjacent, complete unit phrase.
// Multiple numbers or mixed unit phrases cannot supply a missing typed unit.
function unitNearAmount(n, value, evidence, parseUnit) {
  for (const text of [String(value), String(evidence ?? "")]) {
    const amounts = [...text.matchAll(/\d+(?:[.,]\d+)*/g)];
    if (amounts.length !== 1 || parseNumber(amounts[0][0]) !== n) continue;
    const amount = amounts[0];
    const suffix = text
      .slice(amount.index + amount[0].length)
      .trim()
      .replace(/[.!]$/, "");
    const prefix = text
      .slice(0, amount.index)
      .trim()
      .replace(
        /^(?:(?:the\s+)?(?:unit price|price|lead time|capacity)(?:\s+is)?|we can produce)(?:\s+|$)/i,
        "",
      )
      .trim();
    const suffixUnit = parseUnit(suffix);
    const prefixUnit = parseUnit(prefix);
    if ((suffix && !suffixUnit) || (prefix && !prefixUnit)) continue;
    if (suffixUnit && prefixUnit && suffixUnit !== prefixUnit) return null;
    const unit = suffixUnit ?? prefixUnit;
    if (unit) return unit;
  }
  return null;
}

/**
 * Converts one stated fact into the canonical unit, or explains why it cannot.
 * Every conversion applied is returned so the claim can show its work.
 */
export function normalizeFact({ fieldKind, value, unit, period, evidence }) {
  const spec = FIELD_REGISTRY[fieldKind];
  if (!spec)
    return {
      ok: false,
      reason: `Field "${fieldKind}" is outside the registry`,
    };

  const n = parseNumber(value);
  if (n === null) {
    return {
      ok: false,
      reason: `Value "${String(value).slice(0, 40)}" is not a number we can read`,
    };
  }
  if (n < 0)
    return {
      ok: false,
      reason: "Negative value is not meaningful for this field",
    };

  const applied = [];
  if (fieldKind === "capacity") {
    const p = detectPeriod(
      unit,
      period,
      unitNearAmount(n, value, evidence, capacityPeriod),
    );
    if (!p)
      return {
        ok: false,
        reason: "Capacity period is missing, unsupported, or ambiguous",
      };
    const perDay = p === "week" ? n / 7 : p === "month" ? n / 30 : n;
    if (p !== "day") applied.push(`${p} -> day`);
    return {
      ok: true,
      value: Math.round(perDay * 100) / 100,
      unit: "units/day",
      applied,
      statedPeriod: p,
    };
  }

  if (fieldKind === "lead_time_hours") {
    const explicit = String(unit ?? "").trim();
    const duration = explicit
      ? durationUnit(explicit)
      : unitNearAmount(n, value, evidence, durationUnit);
    let hours = n;
    if (duration === "business_days") {
      hours = n * BUSINESS_DAY_HOURS;
      applied.push(`business days x${BUSINESS_DAY_HOURS}h`);
    } else if (duration === "days") {
      hours = n * CALENDAR_DAY_HOURS;
      applied.push(`days x${CALENDAR_DAY_HOURS}h`);
    } else if (duration !== "hours")
      return {
        ok: false,
        reason: "Lead-time unit is missing, unsupported, or ambiguous",
      };
    return {
      ok: true,
      value: Math.round(hours * 100) / 100,
      unit: "hours",
      applied,
    };
  }

  if (fieldKind === "price") {
    const currency = String(unit ?? "").trim()
      ? detectCurrency(unit)
      : unitNearAmount(n, value, evidence, detectCurrency);
    if (!currency)
      return {
        ok: false,
        reason: "Price currency is missing, unsupported, or ambiguous",
      };
    const rate = FX_TO_CAD[currency];
    if (!rate) return { ok: false, reason: `Unknown currency "${currency}"` };
    if (currency !== "CAD")
      applied.push(`${currency} -> CAD @ ${rate.toFixed(4)}`);
    return {
      ok: true,
      value: Math.round(n * rate * 100) / 100,
      unit: "CAD",
      applied,
    };
  }

  return { ok: true, value: n, unit: spec.unit, applied };
}

export async function normalize(db, { runId, traceId, limit = null }) {
  // Keep deterministic normalization usable without loading database drivers.
  const { shortId, stableJson, bumpStage, emitEvent } =
    await import("./db.mjs");
  const counts = {
    considered: 0,
    claimed: 0,
    quarantined: 0,
    ambiguous: 0,
    superseded: 0,
    unlinked: 0,
  };

  const { rows } = await db.query(
    `select x.extraction_id, x.field, x.raw_value, x.raw_unit, x.evidence_text, x.confidence,
            x.ambiguity, x.observed_at, x.resolved_merchant_id, x.resolved_field, x.artifact_id,
            a.source_kind, a.source_reference, a.checksum, a.received_at
       from rox_extractions x join raw_artifacts a using (artifact_id)
      where x.run_id = $1 and x.outcome = 'pending'
      order by x.extraction_id ${limit ? "limit " + Number(limit) : ""}`,
    [runId],
  );

  for (const row of rows) {
    counts.considered += 1;
    const stated = row.raw_value?.value ?? "";

    // A fact we cannot attribute is not a fact we can store: claims are keyed
    // by merchant and field.
    if (!row.resolved_merchant_id || !row.resolved_field) {
      counts.unlinked += 1;
      await db.query(
        `update rox_extractions set outcome='dropped', outcome_reason=$2 where extraction_id=$1`,
        [row.extraction_id, "Could not attribute to a merchant and capability"],
      );
      continue;
    }

    const result = String(stated).trim()
      ? normalizeFact({
          fieldKind: row.field,
          value: stated,
          unit: row.raw_unit,
          period: row.raw_value?.period,
          evidence: row.evidence_text,
        })
      : {
          ok: false,
          reason: row.ambiguity
            ? `Ambiguous: ${row.ambiguity}`
            : "No value stated",
        };

    if (!result.ok) {
      const ambiguous = !String(stated).trim();
      if (ambiguous) counts.ambiguous += 1;
      else counts.quarantined += 1;
      await db.query(
        `insert into quarantined_claims (quarantine_id, artifact_id, reason, run_id, extraction_id, merchant_hint, field, raw_value, stage)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'normalize') on conflict (quarantine_id) do nothing`,
        [
          shortId(runId, row.extraction_id, "q"),
          row.artifact_id,
          result.reason,
          runId,
          row.extraction_id,
          row.resolved_merchant_id,
          row.resolved_field,
          JSON.stringify({ value: stated, unit: row.raw_unit }),
        ],
      );
      await db.query(
        `update rox_extractions set outcome='quarantined', outcome_reason=$2 where extraction_id=$1`,
        [row.extraction_id, result.reason],
      );
      continue;
    }

    const observedAt = row.observed_at ?? row.received_at;
    const authority = SOURCE_AUTHORITY[row.source_kind] ?? 0.5;
    const claimId = shortId(
      "claim",
      row.resolved_merchant_id,
      row.resolved_field,
      row.source_reference,
      stableJson(result.value),
    );

    // A newer statement from the same document reference supersedes the older
    // one; statements from other sources are left alone to corroborate or conflict.
    const { rowCount: superseded } = await db.query(
      `update canonical_claims set resolution_status = 'superseded'
        where merchant_id = $1 and field = $2 and source_reference = $3
          and resolution_status = 'active' and claim_id <> $4
          and normalized_value::text <> $5`,
      [
        row.resolved_merchant_id,
        row.resolved_field,
        row.source_reference,
        claimId,
        JSON.stringify(result.value),
      ],
    );
    counts.superseded += superseded;

    await db.query(
      `insert into canonical_claims
         (claim_id, merchant_id, field, normalized_value, normalized_unit, source_kind, source_reference,
          source_checksum, observed_at, source_authority, extraction_confidence, resolution_status, evidence_text)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12)
       on conflict (claim_id) do nothing`,
      [
        claimId,
        row.resolved_merchant_id,
        row.resolved_field,
        JSON.stringify(result.value),
        result.unit,
        row.source_kind,
        row.source_reference,
        row.checksum,
        observedAt,
        authority,
        Math.min(1, Math.max(0, Number(row.confidence ?? 0.5))),
        row.evidence_text,
      ],
    );
    await db.query(
      `update rox_extractions
          set outcome='claimed', claim_id=$2, normalized_value=$3, normalized_unit=$4,
              outcome_reason = case when $5::text = '' then null else $5::text end
        where extraction_id=$1`,
      [
        row.extraction_id,
        claimId,
        JSON.stringify(result.value),
        result.unit,
        (result.applied ?? []).join("; "),
      ],
    );
    counts.claimed += 1;
  }

  await bumpStage(db, runId, "normalize", counts);
  await emitEvent(db, {
    traceId,
    type: "rox.normalize.completed",
    payload: counts,
  });
  return counts;
}
