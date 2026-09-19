// Seed synthetic MOLECULE_DEMO catalogs into Shopify dev stores. Idempotent (productSet by handle), resumable.
// Usage: node --env-file=.env scripts/seed-shopify.mjs [--store=<subdomain>] [--limit=N] [--budget=140] [--concurrency=4] [--dry] [--wipe]
import { catalogFor, roleForStore } from "./seed-data.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const VERSION = "2026-07";
const budgetMs = Number(args.budget ?? 140) * 1000;
const conc = Number(args.concurrency ?? 4);
const started = Date.now();
const timeLeft = () => budgetMs - (Date.now() - started);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stores = (args.store ? [args.store] : (process.env.SHOPIFY_STORES || "").split(",").map((s) => s.trim()).filter(Boolean));
const clientId = process.env.SHOPIFY_CLIENT_ID, clientSecret = process.env.SHOPIFY_API_SECRET;
const tokens = {};
async function token(shop) {
  if (tokens[shop]) return tokens[shop];
  const res = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }) });
  if (!res.ok) throw new Error(`token ${shop}: HTTP ${res.status}`);
  return (tokens[shop] = (await res.json()).access_token);
}
async function gql(shop, query, variables = {}, attempt = 0) {
  const res = await fetch(`https://${shop}.myshopify.com/admin/api/${VERSION}/graphql.json`, { method: "POST", headers: { "content-type": "application/json", "x-shopify-access-token": await token(shop) }, body: JSON.stringify({ query, variables }) });
  if ((res.status === 429 || res.status >= 500) && attempt < 6) { await sleep(1000 * 2 ** attempt); return gql(shop, query, variables, attempt + 1); }
  const j = await res.json();
  if (j.errors?.some((e) => e.extensions?.code === "THROTTLED") && attempt < 8) { await sleep(1500 * (attempt + 1)); return gql(shop, query, variables, attempt + 1); }
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  const avail = j.extensions?.cost?.throttleStatus?.currentlyAvailable;
  if (avail !== undefined && avail < 300) await sleep(600);
  return j.data;
}

const M = `mutation P($input: ProductSetInput!, $identifier: ProductSetIdentifiers) { productSet(input: $input, identifier: $identifier, synchronous: true) { product { id handle } userErrors { field message code } } }`;

function toInput(p, locationId) {
  const entries = Object.entries(p.options || {});
  const input = { title: p.title, handle: p.handle, descriptionHtml: p.descriptionHtml, vendor: p.vendor, productType: p.type, tags: p.tags, status: "ACTIVE" };
  const list = entries.length ? entries : [["Title", ["Default Title"]]];
  input.productOptions = list.map(([name, vals], i) => ({ name, position: i + 1, values: vals.map((v) => ({ name: v })) }));
  input.variants = p.variants.map((v) => ({
    optionValues: v.optionValues,
    price: v.price,
    inventoryItem: { sku: v.sku, tracked: !!v.tracked },
    ...(v.tracked ? { inventoryQuantities: [{ locationId, name: "available", quantity: v.quantity }] } : {}),
  }));
  return input;
}

async function main() {
  if (!stores.length) throw new Error("No stores (set SHOPIFY_STORES or --store)");
  for (const shop of stores) {
    const role = roleForStore(shop);
    let products = catalogFor(role);
    if (args.limit) products = products.slice(0, Number(args.limit));
    console.log(`\n== ${shop} (role ${role}) catalog ${products.length}`);
    if (args.dry) { console.log(`dry: ${products.length} products, ${products.reduce((n, p) => n + p.variants.length, 0)} variants`); continue; }
    if (args.wipe) {
      let n = 0, cursor = null;
      for (;;) {
        const d = await gql(shop, `query($c:String){products(first:100,after:$c,query:"tag:MOLECULE_DEMO"){edges{node{id}} pageInfo{hasNextPage endCursor}}}`, { c: cursor });
        for (const e of d.products.edges) { if (timeLeft() < 8000) break; await gql(shop, `mutation($id:ID!){productDelete(input:{id:$id}){deletedProductId userErrors{message}}}`, { id: e.node.id }); n++; }
        if (!d.products.pageInfo.hasNextPage || timeLeft() < 8000) break; cursor = d.products.pageInfo.endCursor;
      }
      console.log(`wiped ${n}`); continue;
    }
    const loc = (await gql(shop, `{locations(first:5){edges{node{id name isActive}}}}`)).locations.edges.map((e) => e.node).find((l) => l.isActive);
    const existing = new Set(); let cursor = null;
    for (;;) {
      const d = await gql(shop, `query($c:String){products(first:250,after:$c,query:"tag:MOLECULE_DEMO"){edges{node{handle}} pageInfo{hasNextPage endCursor}}}`, { c: cursor });
      d.products.edges.forEach((e) => existing.add(e.node.handle));
      if (!d.products.pageInfo.hasNextPage) break; cursor = d.products.pageInfo.endCursor;
    }
    const todo = products.filter((p) => !existing.has(p.handle));
    console.log(`already ${existing.size}, to create ${todo.length}`);
    let done = 0, failed = 0, i = 0;
    const worker = async () => {
      while (i < todo.length && timeLeft() > 12000) {
        const p = todo[i++];
        try {
          const d = await gql(shop, M, { input: toInput(p, loc.id), identifier: { handle: p.handle } });
          const errs = d.productSet.userErrors;
          if (errs.length) { failed++; if (failed <= 5) console.log(`  ERR ${p.handle}: ${JSON.stringify(errs).slice(0, 300)}`); } else done++;
        } catch (e) { failed++; if (failed <= 5) console.log(`  EXC ${p.handle}: ${String(e.message).slice(0, 300)}`); }
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    console.log(`created ${done}, failed ${failed}, remaining ${todo.length - done - failed}`);
    if (timeLeft() <= 12000) { console.log("budget reached; rerun to continue"); break; }
  }
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
