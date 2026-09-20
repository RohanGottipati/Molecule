import { createHash } from "node:crypto";

import { CanonicalClaimSchema, type CanonicalClaim } from "@molecule/contracts";
import { interpretCapacity, stableJson } from "@molecule/resolution";

export { stableJson };

export interface RawClaimInput {
  merchantId: string;
  field: string;
  rawValue: unknown;
  sourceKind: CanonicalClaim["source"]["kind"];
  sourceReference: string;
  sourceChecksum?: string;
  observedAt?: string;
  sourceAuthority: number;
  extractionConfidence: number;
  evidenceText?: string;
}

export type NormalizeResult =
  | { ok: true; value: unknown; unit?: string }
  | {
      ok: false;
      reason: string;
      disposition?: "needs_review" | "quarantine";
      code?: string;
    };

/**
 * Normalizes a raw extracted value for a known numeric field. Anything that
 * doesn't parse cleanly is quarantined rather than guessed at (playbook T5
 * acceptance criteria: "malformed CSV row is quarantined, not silently
 * accepted").
 *
 * This intentionally only handles the numeric-with-unit case that the demo
 * fields need (capacity_per_day, price, lead_time_hours, quantity). A field
 * outside this set is passed through unnormalized with ok:true so it still
 * lands as a claim — normalization failure only blocks fields we claim to
 * understand.
 */
export function normalizeValue(
  field: string,
  rawValue: unknown,
  context: Pick<RawClaimInput, "evidenceText" | "observedAt"> = {},
): NormalizeResult {
  field = field.startsWith("inventory.")
    ? "inventory"
    : (field.split(".").at(-1) ?? field);
  const numericFields = new Set([
    "capacity_per_day",
    "price",
    "unitPrice",
    "lead_time_hours",
    "quantity",
    "setup_fee",
    "capacity",
    "inventory",
  ]);

  if (field === "capacity" || field === "capacity_per_day") {
    const result = interpretCapacity({
      value: rawValue,
      unit: typeof rawValue === "string" ? rawValue : undefined,
      evidence: context.evidenceText,
      observedAt: context.observedAt,
    });
    return result.ok
      ? { ok: true, value: result.value, unit: result.unit }
      : {
          ok: false,
          reason: result.reason,
          disposition: result.disposition,
          code: result.code,
        };
  }

  if (!numericFields.has(field)) {
    if (rawValue === null || rawValue === undefined)
      return { ok: false, reason: "Unknown value" };
    return {
      ok: true,
      value:
        typeof rawValue === "string" ? rawValue.trim().toLowerCase() : rawValue,
    };
  }

  if (
    typeof rawValue === "number" &&
    Number.isFinite(rawValue) &&
    rawValue >= 0
  ) {
    return {
      ok: true,
      value: rawValue,
      unit: field === "capacity_per_day" ? "units" : undefined,
    };
  }

  if (typeof rawValue === "string") {
    const cleaned = rawValue.trim();
    const price =
      field === "price" || field === "unitPrice" || field === "setup_fee";
    const pattern = price
      ? /^(?:CAD\s*|\$\s*)?((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)$/
      : field === "lead_time_hours"
        ? /^(\d+(?:\.\d+)?)(?:\s*hours?)?$/
        : field === "capacity_per_day"
          ? /^(\d+(?:\.\d+)?)(?:\s*units?(?:\/day)?)?$/
          : /^(\d+(?:\.\d+)?)(?:\s*units?)?$/;
    const match = cleaned.match(pattern);
    if (match?.[1] && Number.isFinite(Number(match[1].replaceAll(",", "")))) {
      return {
        ok: true,
        value: Number(match[1].replaceAll(",", "")),
        unit: field === "capacity_per_day" ? "units" : undefined,
      };
    }
  }

  return {
    ok: false,
    reason: `Invalid nonnegative numeric value or unit for field "${field}"`,
  };
}

/**
 * Turns a raw ingested fact into a CanonicalClaim, or a quarantine reason.
 * Never mutates or overwrites an existing claim — every ingestion is a new
 * row (AGENTS.md: "unknown/conflicted merchant facts must stay unknown/
 * conflicted; never guess operational truth").
 */
export function toCanonicalClaim(
  input: RawClaimInput,
  now: Date = new Date(),
):
  | { ok: true; claim: CanonicalClaim }
  | Extract<NormalizeResult, { ok: false }> {
  if (
    !input ||
    [input.merchantId, input.field, input.sourceReference].some(
      (value) => typeof value !== "string" || !value.trim(),
    )
  ) {
    return { ok: false, reason: "Invalid claim metadata" };
  }
  if (["capacity", "capacity_per_day", "inventory"].includes(input.field)) {
    return {
      ok: false,
      reason:
        "Operational capacity fields require a capability or resource scope",
      disposition: "quarantine",
      code: "unscoped_operational_field",
    };
  }
  const normalized = normalizeValue(input.field, input.rawValue, input);
  if (!normalized.ok) {
    return normalized;
  }

  if (
    !Number.isFinite(input.sourceAuthority) ||
    input.sourceAuthority < 0 ||
    input.sourceAuthority > 1
  ) {
    return { ok: false, reason: "sourceAuthority must be between 0 and 1" };
  }
  if (
    !Number.isFinite(input.extractionConfidence) ||
    input.extractionConfidence < 0 ||
    input.extractionConfidence > 1
  ) {
    return {
      ok: false,
      reason: "extractionConfidence must be between 0 and 1",
    };
  }

  const claim: CanonicalClaim = {
    claimId: createHash("sha256").update(stableJson(input)).digest("hex"),
    merchantId: input.merchantId,
    field: input.field,
    normalizedValue: normalized.value,
    normalizedUnit: normalized.unit,
    source: {
      kind: input.sourceKind,
      reference: input.sourceReference,
      checksum:
        input.sourceChecksum ??
        createHash("sha256").update(stableJson(input.rawValue)).digest("hex"),
    },
    observedAt: input.observedAt,
    ingestedAt: now.toISOString(),
    sourceAuthority: input.sourceAuthority,
    extractionConfidence: input.extractionConfidence,
    resolutionStatus: "active",
    evidenceText: input.evidenceText,
  };

  const parsed = CanonicalClaimSchema.safeParse(claim);
  if (!parsed.success) {
    return { ok: false, reason: "Invalid claim metadata" };
  }
  return { ok: true, claim: parsed.data };
}
