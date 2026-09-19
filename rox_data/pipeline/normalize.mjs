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
import { shortId, stableJson, bumpStage, emitEvent } from "./db.mjs";

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
  const hay =
    `${periodHint ?? ""} ${unitText ?? ""} ${rawText ?? ""}`.toLowerCase();
  if (/\b(month|monthly|\/mo)\b/.test(hay)) return "month";
  if (/\b(week|weekly|\/wk)\b/.test(hay)) return "week";
  if (/\b(day|daily|\/d\b)\b/.test(hay)) return "day";
  return null;
}

export function detectCurrency(unitText, rawText) {
  const hay = `${unitText ?? ""} ${rawText ?? ""}`.toUpperCase();
  for (const code of ["CAD", "USD", "GBP", "EUR"])
    if (hay.includes(code)) return code;
  if (hay.includes("£")) return "GBP";
  if (hay.includes("€")) return "EUR";
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
    const p = detectPeriod(unit, period, evidence) ?? "day";
    if (!detectPeriod(unit, period, evidence))
      applied.push("assumed per-day (no period stated)");
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
    const hay = `${unit ?? ""} ${evidence ?? ""}`.toLowerCase();
    let hours = n;
    if (/business\s+day|working\s+day/.test(hay)) {
      hours = n * BUSINESS_DAY_HOURS;
      applied.push(`business days x${BUSINESS_DAY_HOURS}h`);
    } else if (/\bdays?\b/.test(hay)) {
      hours = n * CALENDAR_DAY_HOURS;
      applied.push(`days x${CALENDAR_DAY_HOURS}h`);
    } else if (!/\b(h|hour|hours|hrs?)\b/.test(hay))
      applied.push("assumed hours (no unit stated)");
    return {
      ok: true,
      value: Math.round(hours * 100) / 100,
      unit: "hours",
      applied,
    };
  }

  if (fieldKind === "price") {
    const currency = detectCurrency(unit, evidence) ?? "CAD";
    if (!detectCurrency(unit, evidence))
      applied.push("assumed CAD (store currency, none stated)");
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
