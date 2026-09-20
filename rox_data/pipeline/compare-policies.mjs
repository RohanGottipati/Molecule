#!/usr/bin/env node
// Offline replay of capacity normalization under the strict and legacy policies
// over a frozen evaluation snapshot. No database, provider or network access.
// Reports how each policy's promoted values compare with the stated truth, so
// the cost of refusing (recall) and the value of refusing (wrong claims caught)
// are both measured.
//
//   node rox_data/pipeline/compare-policies.mjs \
//     --snapshot=.molecule-data/order1/historical-snapshot.json \
//     --output=.molecule-data/order4/policy-comparison.json
//
// The snapshot is the SYNTHETIC ROX corpus. Nothing here is a real-world
// accuracy figure.
import { readFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { canonicalExpected } from "./evaluate.mjs";
import { normalizeFact, parseNumber } from "./normalize.mjs";

/** Historical unsafe behavior, retained only for offline policy comparison. */
export function normalizeLegacyCapacity({ value, unit, period, evidence }) {
  const number = parseNumber(value);
  if (number === null || number < 0)
    return { ok: false, disposition: "quarantine", code: "unreadable" };
  const text = `${period ?? ""} ${unit ?? ""} ${evidence ?? ""}`.toLowerCase();
  const statedPeriod = /\b(month|monthly|\/mo)\b/.test(text)
    ? "month"
    : /\b(week|weekly|\/wk)\b/.test(text)
      ? "week"
      : "day";
  const days = statedPeriod === "week" ? 7 : statedPeriod === "month" ? 30 : 1;
  return {
    ok: true,
    value: Math.round((number / days) * 100) / 100,
    unit: "units/day",
    statedPeriod,
    applied:
      statedPeriod === "day" && !/\b(day|daily|\/d)\b/.test(text)
        ? ["assumed per-day (no period stated)"]
        : statedPeriod === "day"
          ? []
          : [`${statedPeriod} -> day`],
  };
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);
const kind = (f) => String(f).split(".").at(-1);
const close = (a, b) =>
  a != null &&
  b != null &&
  Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.01);

export function comparePolicies(snapshot) {
  const { artifacts, truth, extractions, config } = snapshot;
  const path = new Map(artifacts.map((a) => [a.artifact_id, a.source_path]));
  const rows = [];
  for (const x of extractions.filter((e) => kind(e.field) === "capacity")) {
    const source = path.get(x.artifact_id);
    const stated = parseNumber(x.raw_value?.value);
    const t = truth.find(
      (r) =>
        r.source_path === source &&
        kind(r.field) === "capacity" &&
        !r.is_injection &&
        r.true_value.expect === "claim" &&
        close(stated, Number(r.true_value.stated)),
    );
    const want = t
      ? canonicalExpected(
          t.true_value.stated,
          t.true_value.statedUnit,
          "capacity",
          config,
        )
      : null;
    const input = {
      fieldKind: "capacity",
      value: x.raw_value?.value ?? "",
      unit: x.raw_unit,
      period: x.raw_value?.period,
      evidence: x.evidence_text,
      observedAt: x.observed_at ?? undefined,
      ambiguity: x.ambiguity,
    };
    const outcome = (policy) => {
      const r =
        policy === "legacy"
          ? normalizeLegacyCapacity(input)
          : normalizeFact(input);
      if (!r.ok)
        return {
          kind: r.disposition ?? "quarantine",
          code: r.code ?? "unreadable",
        };
      if (!want) return { kind: "claim_unmatched" };
      return {
        kind: close(r.value, want.value) ? "claim_correct" : "claim_wrong",
      };
    };
    rows.push({
      matched: Boolean(want),
      sourceType: String(source).split("/")[0],
      legacy: outcome("legacy"),
      strict: outcome("strict"),
    });
  }
  const tally = (key) => {
    const t = {};
    for (const r of rows) t[r[key].kind] = (t[r[key].kind] ?? 0) + 1;
    return t;
  };
  const moved = {};
  for (const r of rows) {
    if (r.legacy.kind === r.strict.kind) continue;
    const k = `${r.legacy.kind} -> ${r.strict.kind}${r.strict.code ? ` (${r.strict.code})` : ""}`;
    moved[k] = (moved[k] ?? 0) + 1;
  }
  const codes = {};
  for (const r of rows)
    if (r.strict.code) codes[r.strict.code] = (codes[r.strict.code] ?? 0) + 1;
  const bySource = {};
  for (const r of rows) {
    const s = (bySource[r.sourceType] ??= {
      legacy_wrong: 0,
      strict_wrong: 0,
      refused_by_strict: 0,
      n: 0,
    });
    s.n++;
    if (r.legacy.kind === "claim_wrong") s.legacy_wrong++;
    if (r.strict.kind === "claim_wrong") s.strict_wrong++;
    if (r.strict.kind === "needs_review" || r.strict.kind === "quarantine")
      s.refused_by_strict++;
  }
  return {
    capacityExtractions: rows.length,
    legacy: tally("legacy"),
    strict: tally("strict"),
    transitions: moved,
    strictReviewReasons: codes,
    bySourceType: bySource,
    note: "Synthetic ROX corpus only; refusing a value that the truth says is correct lowers recall by design.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!args.snapshot || !args.output)
    throw new Error("Required: --snapshot=<json> --output=<new json>");
  const raw = JSON.parse(await readFile(args.snapshot, "utf8"));
  const report = comparePolicies(raw.snapshot ?? raw);
  const handle = await open(args.output, "wx", 0o600);
  await handle.writeFile(JSON.stringify(report, null, 2) + "\n");
  await handle.close();
  console.log(JSON.stringify(report, null, 2));
}
