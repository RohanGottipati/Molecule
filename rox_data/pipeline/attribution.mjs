// Which of a supplier's capabilities does a fact describe? Pure decision logic;
// the database supplies the candidates and the trigram similarities.
//
// Order 2 rule: exact supplier AND capability attribution. Ambiguous identity
// goes to review; it is never attached to the nearest name. Two failure modes
// the previous matcher had, both fixed here:
//   1. A supplier with ONE capability took every fact, even a fact whose
//      subject plainly names a different capability ("bottle engraving" sent to
//      an embroidery-only supplier).
//   2. With several capabilities, the best trigram score won with no check that
//      it beat the runner-up.

const STOP = new Set([
  "units",
  "unit",
  "pieces",
  "piece",
  "custom",
  "service",
  "services",
  "order",
  "orders",
  "logo",
  "item",
  "items",
  "product",
  "products",
  "individual",
  "canadian",
  "standard",
  "backup",
  "capacity",
  "with",
  "from",
  "that",
  "this",
  "your",
  "black",
  "cotton",
  "hoodie",
  "hoodies",
]);

/** Distinctive lowercase words (4+ letters, not generic) in a phrase. */
export function terms(text) {
  return [
    ...new Set(
      String(text ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((w) => w.length >= 4 && !STOP.has(w)),
    ),
  ];
}

const GENERIC = new Set([
  "units",
  "unit",
  "with",
  "from",
  "that",
  "this",
  "your",
  "capacity",
  "item",
  "items",
  "product",
  "products",
  "order",
  "orders",
  "line",
  "lines",
  "our",
  "have",
  "make",
  "custom",
  "service",
  "services",
]);

/** Words that can tell one capability from another, as 5-letter stems so
 *  "hoodies"/"hoodie" and "fulfilment"/"fulfillment" meet. */
export function selectionStems(text) {
  return [
    ...new Set(
      String(text ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((w) => w.length >= 4 && !GENERIC.has(w))
        .map((w) => w.slice(0, 5)),
    ),
  ];
}

const compact = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export const CAPABILITY_MIN_SIMILARITY = 0.25;
export const CAPABILITY_MIN_MARGIN = 0.05;

/**
 * @param own      this supplier's capabilities [{capability_id,name,description}]
 * @param all      every capability in the network (for the contradiction check)
 * @param hint     what the document calls the thing the fact is about
 * @param ranked   top trigram matches within `own`, best first: [{capability_id, sim}]
 * @returns {{capabilityId: string|null, method?: string, score?: number, reason?: string, terms?: string[]}}
 */
export function decideCapability({
  own,
  all = [],
  hint,
  ranked = [],
  minSimilarity = CAPABILITY_MIN_SIMILARITY,
  minMargin = CAPABILITY_MIN_MARGIN,
}) {
  if (!own?.length) return { capabilityId: null, reason: "no_capabilities" };

  // A document that quotes our own identifier is the easiest case.
  const direct = own.find(
    (c) => compact(hint) && compact(c.capability_id) === compact(hint),
  );
  if (direct)
    return { capabilityId: direct.capability_id, method: "exact", score: 1 };

  // The subject names a different capability of the network and nothing of ours.
  const ownIds = new Set(own.map((c) => c.capability_id));
  const ownTerms = new Set(
    own.flatMap((c) => terms(`${c.name} ${c.description ?? ""}`)),
  );
  const foreign = new Set(
    all
      .filter((c) => !ownIds.has(c.capability_id))
      .flatMap((c) => terms(c.name)),
  );
  const contradicting = terms(hint).filter(
    (t) => foreign.has(t) && !ownTerms.has(t),
  );
  if (contradicting.length)
    return {
      capabilityId: null,
      reason: "contradicts_hint",
      terms: contradicting,
    };

  if (own.length === 1)
    // Inferred from the supplier having a single capability. Weaker than a
    // document that names it, and recorded as such.
    return {
      capabilityId: own[0].capability_id,
      method: "only",
      score: terms(hint).length ? 0.8 : 0.6,
    };

  if (!compact(hint)) return { capabilityId: null, reason: "no_hint" };

  // Deterministic word overlap before fuzzy similarity: "our hoodies line" names
  // the hoodie capability even though its trigram score against the full
  // description is low. It must single one capability out, or beat the rest.
  const hintStems = new Set(selectionStems(hint));
  if (hintStems.size) {
    const overlaps = own
      .map((c) => ({
        capabilityId: c.capability_id,
        overlap: selectionStems(
          `${c.capability_id.replace(/[-_]/g, " ")} ${c.name} ${c.description ?? ""}`,
        ).filter((stem) => hintStems.has(stem)).length,
      }))
      .filter((c) => c.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap);
    if (overlaps.length === 1)
      return {
        capabilityId: overlaps[0].capabilityId,
        method: "terms",
        score: 0.7,
      };
    if (overlaps.length > 1 && overlaps[0].overlap > overlaps[1].overlap)
      return {
        capabilityId: overlaps[0].capabilityId,
        method: "terms",
        score: 0.65,
      };
  }

  const [best, second] = ranked;
  if (!best || Number(best.sim) < minSimilarity)
    return { capabilityId: null, reason: "below_threshold" };
  if (second && Number(best.sim) - Number(second.sim) < minMargin)
    return {
      capabilityId: null,
      reason: "ambiguous_margin",
      terms: [best.capability_id, second.capability_id],
    };
  return {
    capabilityId: best.capability_id,
    method: "trgm",
    score: Number(best.sim),
  };
}
