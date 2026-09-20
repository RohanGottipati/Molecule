// Every tunable the pipeline argues about in one place, so the demo can explain
// why a claim won instead of pointing at a magic number.

/** How much we trust a kind of source before recency or confidence is applied. */
export const SOURCE_AUTHORITY = {
  shopify: 0.95, // the live store: authoritative for stock and capacity signals
  api: 0.8, // supplier portal pulls: structured, but often stale
  csv: 0.7, // spreadsheets and WMS exports: structured, hand-maintained
  document: 0.65, // emails, invoices: authoritative author, unstructured
  manual: 0.9,
  note: 0.5, // chat threads: fastest, least formal
};

/** Artifact type -> the source_kind vocabulary canonical_claims already uses. */
export const TYPE_TO_SOURCE_KIND = {
  emails: "document",
  invoices: "document",
  pricesheets: "csv",
  wms: "csv",
  tickets: "api",
  portal: "api",
  threads: "note",
  briefs: "note",
};

export const MEDIA_TYPES = {
  ".eml": "message/rfc822",
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html",
};

/**
 * The fields the pipeline claims to understand. Anything outside this list is
 * extracted but never normalized into a number - we do not pretend to know
 * units we have not defined.
 */
export const FIELD_REGISTRY = {
  capacity: {
    unit: "units/day",
    kind: "quantity",
    periods: ["hour", "day", "week", "month"],
  },
  lead_time_hours: { unit: "hours", kind: "duration" },
  price: { unit: "CAD", kind: "money" },
  moq: { unit: "units", kind: "quantity" },
};

/** Business days -> hours, the conversion suppliers state and the DB does not. */
export const BUSINESS_DAY_HOURS = 8;
export const CALENDAR_DAY_HOURS = 24;

/** Frozen FX for the demo. Real rates would come from an adapter. */
export const FX_TO_CAD = {
  CAD: 1,
  USD: 1 / 0.74,
  GBP: 1 / 0.58,
  EUR: 1 / 0.68,
};

export const MODELS = {
  extract: process.env.ROX_EXTRACT_MODEL ?? "gpt-5.4-mini",
  adjudicate: process.env.ROX_ADJUDICATE_MODEL ?? "gpt-5.6-terra",
  embed: process.env.ROX_EMBED_MODEL ?? "text-embedding-3-small",
};

/** Hard ceiling. The runner aborts rather than exceeding it. */
export const BUDGET_USD = Number(process.env.ROX_BUDGET_USD ?? 50);

/**
 * Prices are operator-maintained (rox_model_prices) - these are the seeds used
 * when the table has no row, deliberately on the high side so the budget guard
 * errs toward stopping early rather than overspending.
 */
export const FALLBACK_PRICES = {
  "gpt-5.4-mini": { input: 0.6, cached: 0.06, output: 2.4 },
  "gpt-5.6-terra": { input: 2.5, cached: 0.25, output: 10 },
  "text-embedding-3-small": { input: 0.02, cached: 0.02, output: 0 },
};

/** Evidence is mandatory: a candidate the model cannot cite is dropped. */
export const REQUIRE_EVIDENCE = true;

/**
 * Resolution constants come from the shared resolver, not a local copy, so the
 * pipeline and the Reality service cannot disagree about what is true.
 */
export {
  CONFLICT_MARGIN_THRESHOLD as CONFLICT_MARGIN,
  RECENCY_HALF_LIFE_DAYS,
  RESOLUTION_WEIGHTS,
} from "@molecule/resolution";

/** Entity resolution bands: above `link` we merge, below `review` we reject. */
export const ENTITY_THRESHOLDS = { link: 0.9, review: 0.55 };

/**
 * How capacity figures with no stated period, ranges, bounds, hourly rates and
 * out-of-window dates are handled.
 *   strict - (default) anything the source does not support goes to review.
 *   legacy - the pre-Order-4 behaviour: assume per-day, drop hedges. Kept only to
 *            reproduce historical synthetic scores; never use it for real data.
 */
export const CAPACITY_POLICY = process.env.ROX_CAPACITY_POLICY ?? "strict";
