#!/usr/bin/env node
// Offline: how good is each entity-matching method (exact, trigram, pgvector,
// model)? Reads a frozen evaluation snapshot; no database or provider access.
//
//   node rox_data/pipeline/matching-quality.mjs \
//     --snapshot=.molecule-data/order1/historical-snapshot.json \
//     --output=.molecule-data/order6/matching-quality.json
//
// For each extraction that has a truth row (same source, same field kind, same
// stated value), attribution is correct when BOTH the merchant and the
// capability-qualified field match. Precision is per method; extractions the
// pipeline could not attribute are counted separately, never as correct.
// Synthetic corpus only.
import { open, readFile } from "node:fs/promises";
import { parseNumber } from "./numbers.mjs";

const kind = (f) => String(f).split(".").at(-1);
const close = (a, b) =>
  a != null &&
  b != null &&
  Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.01);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

function pair(snapshot, strategy) {
  const { artifacts, truth, extractions } = snapshot;
  const path = new Map(artifacts.map((a) => [a.artifact_id, a.source_path]));
  const used = new Set();
  const byMethod = {};
  let unattributed = 0;
  let unmatched = 0;
  let ambiguous = 0;
  for (const x of [...extractions].sort((a, b) =>
    a.extraction_id.localeCompare(b.extraction_id),
  )) {
    const source = path.get(x.artifact_id);
    const stated = parseNumber(x.raw_value?.value);
    const candidates = truth.filter(
      (r) =>
        !used.has(r.truth_id) &&
        r.source_path === source &&
        kind(r.field) === kind(x.field) &&
        !r.is_injection &&
        r.true_value.expect === "claim" &&
        close(stated, Number(r.true_value.stated)),
    );
    if (!candidates.length) {
      unmatched++;
      continue;
    }
    // Several expected facts can share a source, a field kind and a value (two
    // capabilities both at 600/day). Value pairing cannot tell them apart.
    if (new Set(candidates.map((r) => `${r.merchant_id}|${r.field}`)).size > 1)
      ambiguous++;
    const t =
      strategy === "prefer_attributed"
        ? (candidates.find(
            (r) =>
              r.merchant_id === x.resolved_merchant_id &&
              r.field === x.resolved_field,
          ) ?? candidates[0])
        : candidates[0];
    used.add(t.truth_id);
    if (!x.resolved_merchant_id) {
      unattributed++;
      continue;
    }
    const method = x.link_method ?? "unknown";
    const m = (byMethod[method] ??= { n: 0, merchant: 0, full: 0 });
    m.n++;
    if (x.resolved_merchant_id === t.merchant_id) m.merchant++;
    if (
      x.resolved_merchant_id === t.merchant_id &&
      x.resolved_field === t.field
    )
      m.full++;
  }
  const total = Object.values(byMethod).reduce(
    (a, m) => ({
      n: a.n + m.n,
      merchant: a.merchant + m.merchant,
      full: a.full + m.full,
    }),
    { n: 0, merchant: 0, full: 0 },
  );
  const view = (m) => ({
    attributed: m.n,
    merchant_precision_pct: pct(m.merchant, m.n),
    merchant_and_capability_precision_pct: pct(m.full, m.n),
  });
  return {
    unattributed,
    unmatchedToTruth: unmatched,
    pairingAmbiguous: ambiguous,
    overall: view(total),
    byMethod: Object.fromEntries(
      Object.entries(byMethod).map(([k, m]) => [k, view(m)]),
    ),
  };
}

export function matchingQuality(snapshot) {
  return {
    // Value-only pairing: an ambiguous pairing is scored against the first
    // candidate, so shared values can only make the result look worse.
    pessimistic: pair(snapshot, "first"),
    // Attribution-aware pairing: an ambiguous pairing takes the candidate the
    // pipeline chose, so shared values can only make the result look better.
    optimistic: pair(snapshot, "prefer_attributed"),
    note: "Synthetic ROX corpus. The true precision lies between the two; the gap is pairing ambiguity in the benchmark, not pipeline behaviour.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...v] = a.replace(/^--/, "").split("=");
      return [k, v.join("=")];
    }),
  );
  if (!args.snapshot || !args.output)
    throw new Error("Required: --snapshot=<json> --output=<new json>");
  const raw = JSON.parse(await readFile(args.snapshot, "utf8"));
  const report = matchingQuality(raw.snapshot ?? raw);
  const handle = await open(args.output, "wx", 0o600);
  await handle.writeFile(JSON.stringify(report, null, 2) + "\n");
  await handle.close();
  console.log(JSON.stringify(report, null, 2));
}
