// Shared helpers for the Shopify <-> Tiger DB scripts. No secrets are ever printed.
import { createRequire } from "node:module";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MERCHANT_IDS, roleForStore } from "../seed-data.mjs";

export const API_VERSION = "2026-07";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
}

export const maskUrl = (u) => String(u).replace(/(:\/\/[^:]*:)[^@]*@/, "$1****@");

/** Store handles from SHOPIFY_STORES (bare handles or full domains). */
export function storeHandles(only) {
  const all = (process.env.SHOPIFY_STORES || "").split(",").map((s) => s.trim().replace(/\.myshopify\.com$/, "")).filter(Boolean);
  return only ? all.filter((s) => s === only || s.startsWith(only)) : all;
}
export const merchantIdForStore = (handle) => MERCHANT_IDS[roleForStore(handle)] ?? roleForStore(handle);

/** Connect to Postgres (uses the repo's `pg`, or MOLECULE_TOOLS_DIR/node_modules when the workspace is not installed). */
export async function connectDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  let pg;
  try { pg = (await import("pg")).default; }
  catch { pg = createRequire(join(process.env.MOLECULE_TOOLS_DIR || process.cwd(), "x.js"))("pg"); }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Same canonical JSON as services/reality/src/ingestion.ts stableJson. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, e]) => e !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, e]) => `${JSON.stringify(k)}:${stableJson(e)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** UUID-shaped deterministic id (events require a uuid). */
export function uuidFrom(key) {
  const h = sha256(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const tokens = new Map();
async function token(handle) {
  const hit = tokens.get(handle);
  if (hit && hit.exp > Date.now()) return hit.value;
  const res = await fetch(`https://${handle}.myshopify.com/admin/oauth/access_token`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: process.env.SHOPIFY_CLIENT_ID, client_secret: process.env.SHOPIFY_API_SECRET }),
  });
  if (!res.ok) throw new Error(`token ${handle}: HTTP ${res.status}`);
  const j = await res.json();
  tokens.set(handle, { value: j.access_token, exp: Date.now() + 55 * 60 * 1000 });
  return j.access_token;
}

/** Admin GraphQL with THROTTLED / 429 / 5xx backoff. */
export async function gql(handle, query, variables = {}, attempt = 0) {
  const res = await fetch(`https://${handle}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST", headers: { "content-type": "application/json", "x-shopify-access-token": await token(handle) },
    body: JSON.stringify({ query, variables }),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 6) { await sleep(1000 * 2 ** attempt); return gql(handle, query, variables, attempt + 1); }
  const j = await res.json();
  if (j.errors?.some((e) => e.extensions?.code === "THROTTLED") && attempt < 8) { await sleep(1500 * (attempt + 1)); return gql(handle, query, variables, attempt + 1); }
  if (j.errors) throw new Error(`${handle}: ${JSON.stringify(j.errors).slice(0, 300)}`);
  const avail = j.extensions?.cost?.throttleStatus?.currentlyAvailable;
  if (avail !== undefined && avail < 250) await sleep(700);
  return j.data;
}

/** Which capability each Shopify capacity-signal product feeds (Reality field `<capabilityId>.capacity`). */
export const CAPACITY_SIGNALS = {
  "stitch-works": [{ capabilityId: "cap-stitch-embroidery", title: /^Embroidery Capacity/i }],
  "thread-forge": [{ capabilityId: "cap-thread-embroidery", title: /^Embroidery Capacity/i }],
  "laser-lab": [{ capabilityId: "cap-laser-engraving", title: /^Engraving Capacity/i }],
  "pack-ship": [
    { capabilityId: "cap-pack-assembly", title: /^Assembly Capacity/i },
    { capabilityId: "cap-pack-fulfillment", title: /^Fulfil+ment Capacity/i },
  ],
};
export const SHOPIFY_CLAIM_AUTHORITY = 0.95;
