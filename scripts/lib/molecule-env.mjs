// Shared helpers for the Shopify <-> Tiger DB scripts. No secrets are ever printed.
import { createRequire } from "node:module";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ShopifyTransport } from "../../packages/shopify/dist/transport.js";
import { MERCHANT_IDS, roleForStore } from "../seed-data.mjs";

export const API_VERSION = "2026-07";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(
    argv.map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    }),
  );
}

export const maskUrl = (u) =>
  String(u).replace(/(:\/\/[^:]*:)[^@]*@/, "$1****@");

/** Store handles from SHOPIFY_STORES (bare handles or full domains). */
export function storeHandles(only) {
  const all = (process.env.SHOPIFY_STORES || "")
    .split(",")
    .map((s) => s.trim().replace(/\.myshopify\.com$/, ""))
    .filter(Boolean);
  return only ? all.filter((s) => s === only || s.startsWith(only)) : all;
}
export const merchantIdForStore = (handle) =>
  MERCHANT_IDS[roleForStore(handle)] ?? roleForStore(handle);

/** Connect to Postgres (uses the repo's `pg`, or MOLECULE_TOOLS_DIR/node_modules when the workspace is not installed). */
export async function connectDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch {
    pg = createRequire(
      process.env.MOLECULE_TOOLS_DIR
        ? join(process.env.MOLECULE_TOOLS_DIR, "package.json")
        : new URL("../../packages/db/package.json", import.meta.url),
    )("pg");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Same canonical JSON as services/reality/src/ingestion.ts stableJson. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, e]) => e !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, e]) => `${JSON.stringify(k)}:${stableJson(e)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** UUID-shaped deterministic id (events require a uuid). */
export function uuidFrom(key) {
  const h = sha256(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Scripts and the runtime share token refresh, timeouts, version checks and
// mutation retry rules. Build @molecule/shopify before using operational scripts.
const transports = new Map();
const { z } = createRequire(
  new URL("../../packages/shopify/package.json", import.meta.url),
)("zod");
export async function gql(handle, query, variables = {}) {
  const domain = handle.endsWith(".myshopify.com")
    ? handle
    : `${handle}.myshopify.com`;
  if (!transports.has(domain))
    transports.set(
      domain,
      new ShopifyTransport({
        domain,
        auth: process.env.SHOPIFY_ACCESS_TOKEN
          ? { accessToken: process.env.SHOPIFY_ACCESS_TOKEN }
          : {
              clientId:
                process.env.SHOPIFY_CLIENT_ID ||
                process.env.SHOPIFY_API_KEY ||
                "",
              clientSecret: process.env.SHOPIFY_API_SECRET || "",
            },
      }),
    );
  return transports
    .get(domain)
    .graphql(
      query,
      variables,
      z.record(z.string(), z.unknown()),
      /(?:^|\n)\s*mutation\b/.test(query),
    );
}

/** Which capability each Shopify capacity-signal product feeds (Reality field `<capabilityId>.capacity`). */
export const CAPACITY_SIGNALS = {
  "stitch-works": [
    { capabilityId: "cap-stitch-embroidery", title: /^Embroidery Capacity/i },
  ],
  "thread-forge": [
    { capabilityId: "cap-thread-embroidery", title: /^Embroidery Capacity/i },
  ],
  "laser-lab": [
    { capabilityId: "cap-laser-engraving", title: /^Engraving Capacity/i },
  ],
  "pack-ship": [
    { capabilityId: "cap-pack-assembly", title: /^Assembly Capacity/i },
    { capabilityId: "cap-pack-fulfillment", title: /^Fulfil+ment Capacity/i },
  ],
};
export const SHOPIFY_CLAIM_AUTHORITY = 0.95;
