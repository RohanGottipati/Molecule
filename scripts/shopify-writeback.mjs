// Write database results back into Shopify Admin (metafields on products) and reconcile capacity signals to the DB baseline.
//   node --env-file=.env --env-file=.env.local scripts/shopify-writeback.mjs [--dry] [--store=<handle>] [--definitions-only] [--reconcile-capacity]
// Metafields are namespace `molecule` on PRODUCT with definitions, so they appear under each product's Metafields in Admin.
import {
  CAPACITY_SIGNALS, connectDb, gql, maskUrl, merchantIdForStore, parseArgs, stableJson, storeHandles,
} from "./lib/molecule-env.mjs";

const args = parseArgs();
const dry = Boolean(args.dry);

const DEFINITIONS = [
  ["merchant_id", "Molecule merchant ID", "single_line_text_field", "Merchant ID used by the Molecule database."],
  ["last_synced_at", "Molecule last synced", "date_time", "When this product was last mirrored into the Molecule database."],
  ["capability_id", "Molecule capability", "single_line_text_field", "Capability this capacity signal feeds."],
  ["claim_status", "Molecule claim status", "single_line_text_field", "resolved, conflicted or unknown, as decided by the Molecule resolver."],
  ["resolved_value", "Molecule resolved capacity", "number_integer", "Capacity (units per day) the Molecule database currently trusts."],
  ["resolution_source", "Molecule resolution source", "single_line_text_field", "Which claim won and why."],
  ["p50_hours", "Molecule p50 lead time (h)", "number_decimal", "Median actual fulfilment hours from database samples."],
  ["p95_hours", "Molecule p95 lead time (h)", "number_decimal", "95th percentile actual fulfilment hours."],
  ["on_time_rate", "Molecule success rate", "number_decimal", "Share of historical fulfilment samples that succeeded (0 to 1)."],
];

// Same scoring as services/reality/src/resolution.ts, used only when Reality has not persisted a resolution yet.
function resolve(claims, now = new Date()) {
  const active = claims.filter((c) => ["active", "conflicted"].includes(c.resolution_status) && c.normalized_value !== null);
  if (!active.length) return { status: "unknown" };
  const scored = active.map((c) => {
    const ageDays = Math.max(0, (now - new Date(c.observed_at ?? c.ingested_at)) / 864e5);
    const agree = new Set(active.filter((o) => o.claim_id !== c.claim_id && o.source_reference !== c.source_reference && stableJson(o.normalized_value) === stableJson(c.normalized_value)).map((o) => o.source_reference)).size;
    const score = 0.35 * Number(c.source_authority) + 0.3 * 0.5 ** (ageDays / 7) + 0.25 * Number(c.extraction_confidence) + 0.1 * (agree ? 1 - 1 / (agree + 1) : 0);
    return { c, score };
  }).sort((a, b) => b.score - a.score);
  const top = scored[0], runner = scored.find((s) => stableJson(s.c.normalized_value) !== stableJson(top.c.normalized_value));
  if (!runner || top.score - runner.score >= 0.08) return { status: "resolved", value: Number(top.c.normalized_value), source: top.c.source_reference.startsWith(`${top.c.source_kind}:`) ? top.c.source_reference : `${top.c.source_kind}:${top.c.source_reference}`, score: top.score };
  return { status: "conflicted", value: null, source: scored.map((s) => `${JSON.stringify(s.c.normalized_value)}@${s.score.toFixed(2)}`).join(" vs ") };
}

async function ensureDefinitions(handle) {
  const out = { created: 0, existed: 0, errors: [] };
  for (const [key, name, type, description] of DEFINITIONS) {
    if (dry) continue;
    const d = await gql(handle, `mutation($d:MetafieldDefinitionInput!){metafieldDefinitionCreate(definition:$d){createdDefinition{id} userErrors{code message}}}`,
      { d: { name, namespace: "molecule", key, type, ownerType: "PRODUCT", description } });
    const errs = d.metafieldDefinitionCreate.userErrors;
    if (!errs.length) out.created++;
    else if (errs.every((e) => e.code === "TAKEN")) out.existed++;
    else out.errors.push(`${key}: ${errs.map((e) => e.message).join("; ")}`);
  }
  return out;
}

async function reconcileCapacity(db, handle, merchantId) {
  const signals = CAPACITY_SIGNALS[merchantId] ?? [];
  const log = [];
  if (!signals.length) return log;
  const loc = (await gql(handle, `{locations(first:5){edges{node{id isActive}}}}`)).locations.edges.map((e) => e.node).find((l) => l.isActive);
  const found = (await gql(handle, `{products(first:20,query:"tag:capacity"){edges{node{id title variants(first:1){edges{node{id inventoryQuantity inventoryItem{id tracked}}}}}}}}`)).products.edges.map((e) => e.node);
  for (const sig of signals) {
    const base = await db.query("select capability_json #>> '{capacity,available}' as v from demo_capability_baselines where capability_id=$1", [sig.capabilityId]);
    const target = Number(base.rows[0]?.v);
    if (!Number.isFinite(target)) { log.push({ capabilityId: sig.capabilityId, action: "skip-no-baseline" }); continue; }
    const product = found.find((p) => sig.title.test(p.title));
    if (!product) {
      const title = sig.capabilityId === "cap-pack-fulfillment" ? "Fulfillment Capacity - Kits per Day" : `${sig.capabilityId} Capacity`;
      if (dry) { log.push({ capabilityId: sig.capabilityId, action: "would-create", title, target }); continue; }
      const kind = sig.capabilityId.includes("fulfillment") ? "fulfill" : "transform";
      const r = await gql(handle, `mutation($i:ProductSetInput!,$id:ProductSetIdentifiers){productSet(input:$i,identifier:$id,synchronous:true){product{id} userErrors{field message code}}}`, {
        id: { handle: `${sig.capabilityId}-capacity-signal` },
        i: { title, handle: `${sig.capabilityId}-capacity-signal`, vendor: merchantId, productType: "Capacity", status: "ACTIVE",
          descriptionHtml: "<p>Synthetic demonstration data; not a verified merchant quote.</p><p>Live daily capacity indicator: inventory equals units available per day.</p>",
          tags: ["MOLECULE_DEMO", "capacity", "live-signal", `kind:${kind}`, `merchant:${handle.split("-")[0]}`],
          productOptions: [{ name: "Title", position: 1, values: [{ name: "Default Title" }] }],
          variants: [{ optionValues: [{ optionName: "Title", name: "Default Title" }], price: "0.00", inventoryItem: { sku: `${sig.capabilityId.toUpperCase()}-CAPACITY`, tracked: true },
            inventoryQuantities: [{ locationId: loc.id, name: "available", quantity: target }] }] } });
      const errs = r.productSet.userErrors;
      log.push({ capabilityId: sig.capabilityId, action: errs.length ? `create-failed ${JSON.stringify(errs).slice(0, 200)}` : "created", title, target });
      continue;
    }
    const v = product.variants.edges[0].node;
    if (v.inventoryQuantity === target) { log.push({ capabilityId: sig.capabilityId, action: "already-matches", value: target }); continue; }
    if (dry) { log.push({ capabilityId: sig.capabilityId, action: "would-set", from: v.inventoryQuantity, to: target }); continue; }
    const r = await gql(handle, `mutation($i:InventorySetQuantitiesInput!,$k:String!){inventorySetQuantities(input:$i) @idempotent(key:$k){userErrors{field message code}}}`, {
      k: `molecule-reconcile-${v.inventoryItem.id.split("/").pop()}-${v.inventoryQuantity}-${target}`,
      i: { name: "available", reason: "correction", quantities: [{ inventoryItemId: v.inventoryItem.id, locationId: loc.id, quantity: target, changeFromQuantity: v.inventoryQuantity }] } });
    const errs = r.inventorySetQuantities.userErrors;
    log.push({ capabilityId: sig.capabilityId, action: errs.length ? `set-failed ${JSON.stringify(errs).slice(0, 200)}` : "set", from: v.inventoryQuantity, to: target });
  }
  return log;
}

async function writeMetafields(db, handle, merchantId) {
  const products = (await db.query("select product_gid, tags, title from shopify_products where shop_domain=$1 and status<>'MISSING'", [`${handle}.myshopify.com`])).rows;
  const now = new Date().toISOString();
  const risk = new Map((await db.query(`select capability_id, p50_hours, p95_hours from merchant_risk where merchant_id=$1`, [merchantId])).rows.map((r) => [r.capability_id, r]));
  const success = new Map((await db.query(`select capability_id, avg(success::int) as rate, count(*)::int n from fulfillment_samples where merchant_id=$1 group by capability_id`, [merchantId])).rows.map((r) => [r.capability_id, r]));
  const fields = [];
  const cap = new Map();
  for (const sig of CAPACITY_SIGNALS[merchantId] ?? []) {
    const p = products.find((x) => x.tags.includes("capacity") && sig.title.test(x.title));
    if (p) cap.set(p.product_gid, sig.capabilityId);
  }
  const explained = [];
  for (const p of products) {
    fields.push({ ownerId: p.product_gid, namespace: "molecule", key: "merchant_id", type: "single_line_text_field", value: merchantId });
    fields.push({ ownerId: p.product_gid, namespace: "molecule", key: "last_synced_at", type: "date_time", value: now });
    const capabilityId = cap.get(p.product_gid);
    if (!capabilityId) continue;
    const field = `${capabilityId}.capacity`;
    const res = await db.query("select status, value, explanation from canonical_resolutions where merchant_id=$1 and field=$2", [merchantId, field]);
    let status, value, source;
    if (res.rows[0]) { status = res.rows[0].status; value = res.rows[0].value; source = String(res.rows[0].explanation).slice(0, 250); }
    else {
      const claims = (await db.query("select * from canonical_claims where merchant_id=$1 and field=$2", [merchantId, field])).rows;
      const r = resolve(claims); status = r.status; value = r.value ?? null; source = r.source ? `${r.source}${r.score ? ` (score ${r.score.toFixed(3)})` : ""}` : "no claims";
    }
    const set = (key, type, v) => { if (v !== null && v !== undefined) fields.push({ ownerId: p.product_gid, namespace: "molecule", key, type, value: String(v) }); };
    set("capability_id", "single_line_text_field", capabilityId);
    set("claim_status", "single_line_text_field", status);
    set("resolved_value", "number_integer", value !== null && Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);
    set("resolution_source", "single_line_text_field", source);
    const rk = risk.get(capabilityId), sc = success.get(capabilityId);
    set("p50_hours", "number_decimal", rk ? Number(rk.p50_hours).toFixed(1) : null);
    set("p95_hours", "number_decimal", rk ? Number(rk.p95_hours).toFixed(1) : null);
    set("on_time_rate", "number_decimal", sc ? Number(sc.rate).toFixed(3) : null);
    explained.push(`${capabilityId}: ${status}${value !== null ? `=${value}` : ""}${rk ? ` p95=${Number(rk.p95_hours).toFixed(1)}h` : ""}`);
  }
  let written = 0, failed = [];
  if (!dry) {
    for (let i = 0; i < fields.length; i += 25) {
      const r = await gql(handle, `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){metafields{id} userErrors{field message code}}}`, { m: fields.slice(i, i + 25) });
      const errs = r.metafieldsSet.userErrors;
      if (errs.length) failed.push(...errs.slice(0, 2).map((e) => e.message)); else written += Math.min(25, fields.length - i);
    }
  }
  return { products: products.length, metafields: fields.length, written, failed: failed.slice(0, 3), explained };
}

async function main() {
  const handles = storeHandles(args.store).filter((h) => merchantIdForStore(h) !== "molecule");
  const db = await connectDb();
  console.log(`Shopify write-back ${dry ? "(dry run) " : ""}stores=${handles.length} db=${maskUrl(process.env.DATABASE_URL)}`);
  try {
    for (const handle of handles) {
      const merchantId = merchantIdForStore(handle);
      const d = await ensureDefinitions(handle);
      console.log(`  ${handle.padEnd(24)} definitions created=${d.created} existed=${d.existed}${d.errors.length ? ` ERRORS ${d.errors.join(" | ")}` : ""}`);
      if (args["definitions-only"]) continue;
      if (args["reconcile-capacity"]) for (const l of await reconcileCapacity(db, handle, merchantId)) console.log(`    capacity ${JSON.stringify(l)}`);
      const m = await writeMetafields(db, handle, merchantId);
      console.log(`    metafields products=${m.products} fields=${m.metafields} written=${m.written}${m.failed.length ? ` FAILED ${m.failed.join(" | ")}` : ""}`);
      for (const line of m.explained) console.log(`    result ${line}`);
    }
  } finally { await db.end(); }
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
