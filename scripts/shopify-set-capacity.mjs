// Set a supplier's capacity-signal inventory in Shopify (the demo "judge edits Admin" moment, scriptable).
//   node --env-file=.env scripts/shopify-set-capacity.mjs --store=threadforge --qty=0 [--match="Embroidery Capacity"]
import { gql, merchantIdForStore, parseArgs, storeHandles } from "./lib/molecule-env.mjs";

const args = parseArgs();
const qty = Number(args.qty);
if (!args.store || !Number.isInteger(qty) || qty < 0) { console.error("usage: --store=<handle prefix> --qty=<int >= 0> [--match=<title text>]"); process.exit(1); }
const handle = storeHandles(args.store)[0];
if (!handle) { console.error(`No store matches ${args.store}`); process.exit(1); }
const loc = (await gql(handle, `{locations(first:5){edges{node{id isActive}}}}`)).locations.edges.map((e) => e.node).find((l) => l.isActive);
const products = (await gql(handle, `{products(first:20,query:"tag:capacity"){edges{node{id title variants(first:1){edges{node{inventoryQuantity inventoryItem{id}}}}}}}}`)).products.edges.map((e) => e.node);
const p = products.find((x) => !args.match || x.title.toLowerCase().includes(String(args.match).toLowerCase()));
if (!p) { console.error(`No capacity product found in ${handle}`); process.exit(1); }
const v = p.variants.edges[0].node;
const r = await gql(handle, `mutation($i:InventorySetQuantitiesInput!,$k:String!){inventorySetQuantities(input:$i) @idempotent(key:$k){userErrors{field message code}}}`, {
  k: `molecule-set-capacity-${v.inventoryItem.id.split("/").pop()}-${Date.now()}`,
  i: { name: "available", reason: "correction", quantities: [{ inventoryItemId: v.inventoryItem.id, locationId: loc.id, quantity: qty, changeFromQuantity: v.inventoryQuantity }] } });
const errs = r.inventorySetQuantities.userErrors;
if (errs.length) { console.error("FAILED", JSON.stringify(errs)); process.exit(1); }
console.log(`${merchantIdForStore(handle)} "${p.title}": ${v.inventoryQuantity} -> ${qty}`);
