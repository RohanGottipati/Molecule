import { randomUUID } from "node:crypto";

import type { CanonicalClaim } from "@molecule/contracts";

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
  | { ok: true; value: number; unit?: string }
  | { ok: false; reason: string };

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
export function normalizeValue(field: string, rawValue: unknown): NormalizeResult {
  const numericFields = new Set([
    "capacity_per_day",
    "price",
    "lead_time_hours",
    "quantity",
    "setup_fee",
  ]);

  if (!numericFields.has(field)) {
    return { ok: true, value: rawValue as number };
  }

  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return { ok: true, value: rawValue, unit: field === "capacity_per_day" ? "units" : undefined };
  }

  if (typeof rawValue === "string") {
    const cleaned = rawValue.replace(/[,$]/g, "").trim();
    const match = cleaned.match(/^-?\d+(\.\d+)?/);
    if (match && Number.isFinite(Number(match[0]))) {
      return { ok: true, value: Number(match[0]) };
    }
  }

  return {
    ok: false,
    reason: `Could not parse a numeric value for field "${field}" from: ${JSON.stringify(rawValue)}`,
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
): { ok: true; claim: CanonicalClaim } | { ok: false; reason: string } {
  const normalized = normalizeValue(input.field, input.rawValue);
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason };
  }

  if (input.sourceAuthority < 0 || input.sourceAuthority > 1) {
    return { ok: false, reason: "sourceAuthority must be between 0 and 1" };
  }
  if (input.extractionConfidence < 0 || input.extractionConfidence > 1) {
    return { ok: false, reason: "extractionConfidence must be between 0 and 1" };
  }

  const claim: CanonicalClaim = {
    claimId: randomUUID(),
    merchantId: input.merchantId,
    field: input.field,
    normalizedValue: normalized.value,
    normalizedUnit: normalized.unit,
    source: {
      kind: input.sourceKind,
      reference: input.sourceReference,
      checksum: input.sourceChecksum,
    },
    observedAt: input.observedAt,
    ingestedAt: now.toISOString(),
    sourceAuthority: input.sourceAuthority,
    extractionConfidence: input.extractionConfidence,
    resolutionStatus: "active",
    evidenceText: input.evidenceText,
  };

  return { ok: true, claim };
}
