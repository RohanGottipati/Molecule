#!/usr/bin/env node
// Fill Shopify dev stores with real Open Food Facts products (from bulk_products in Tiger). Resumable, rate-limit aware.
//
//   node --env-file=.env --env-file=.env.local scripts/bulk/shopify-catalog-fill.mjs --stores=snackbox,basegoods --per-store=5000 [--max-seconds=100] [--dry] [--limit=N]
//
//   --bulk       submit a Shopify bulk mutation per store (server-side, async; --batch=10000 products each)
//   --collect    poll open bulk operations and record their results in Tiger
//   --uci        load the non-food UCI Online Retail II catalogue into the supplier
//                stores instead of OFF food (one pass, all stores, prices GBP->CAD)
//
// Products are upserted by handle (`off-<barcode>`), tagged MOLECULE_DEMO, and recorded in bulk_shopify_fill.
// Prices are synthetic (OFF has none) and the tag `synthetic-price` says so. Re-run until the cap is reached.
import {
  connectDb,
  gql,
  parseArgs,
  storeHandles,
  sleep,
} from "../lib/molecule-env.mjs";

const args = parseArgs();
const perStore = Number(args["per-store"] ?? 5000);
const maxSeconds = Number(args["max-seconds"] ?? 100);
const limit = args.limit ? Number(args.limit) : Infinity; // per store per run
const deadline = Date.now() + maxSeconds * 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// snack-like categories go to SnackBox; everything else that is food goes to BaseGoods
const SNACK = [
  "Sugary snacks",
  "Salty snacks",
  "Beverages",
  "Snacks",
  "Confectioneries",
  "Biscuits",
  "Sodas",
  "Frozen desserts",
  "Chocolate products",
  "Cookies",
];
const JUNK = [
  "Undefined",
  "Null",
  "unknown",
  "Alcoholic beverages",
  "Baby foods",
  "Groceries",
];
const wanted = String(args.stores ?? "snackbox,basegoods").split(",");
const stores = wanted
  .flatMap((w) => storeHandles(w))
  .filter((h, i, a) => a.indexOf(h) === i);
if (!stores.length) throw new Error("no matching stores in SHOPIFY_STORES");

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const MUTATION = `mutation($input: ProductSetInput!, $id: ProductSetIdentifiers) {
  productSet(synchronous: true, input: $input, identifier: $id) { product { id handle } userErrors { field message code } }
}`;

function toInput(p) {
  const size = (p.quantity_label || "").slice(0, 60) || "Standard";
  const facts = [
    p.nutriscore && `Nutri-Score ${String(p.nutriscore).toUpperCase()}`,
    p.nova_group && `NOVA ${p.nova_group}`,
    p.kcal_100g != null && `${Math.round(p.kcal_100g)} kcal/100g`,
    p.sugars_100g != null && `sugars ${p.sugars_100g} g`,
    p.fat_100g != null && `fat ${p.fat_100g} g`,
    p.protein_100g != null && `protein ${p.protein_100g} g`,
    p.salt_100g != null && `salt ${p.salt_100g} g`,
  ]
    .filter(Boolean)
    .join(" · ");
  const tags = [
    "MOLECULE_DEMO",
    "open-food-facts",
    "synthetic-price",
    p.category && `cat:${p.category}`.slice(0, 40),
    p.nutriscore && `nutriscore-${p.nutriscore}`,
  ].filter(Boolean);
  return {
    handle: `off-${p.sku}`,
    title: p.title.slice(0, 250),
    vendor: (p.brand || "Unknown").slice(0, 100),
    productType: (p.subcategory || p.category || "Food").slice(0, 100),
    status: "ACTIVE",
    tags,
    descriptionHtml: `<p>${esc(p.title)} by ${esc(p.brand)}.</p>${facts ? `<p>${esc(facts)}</p>` : ""}${p.ingredients ? `<p><em>Ingredients:</em> ${esc(p.ingredients)}</p>` : ""}<p><small>Source: Open Food Facts (ODbL). Price is synthetic demo data.</small></p>`,
    productOptions: [{ name: "Size", values: [{ name: size }] }],
    variants: [
      {
        optionValues: [{ optionName: "Size", name: size }],
        price: String(p.price),
        sku: `OFF-${p.sku}`,
      },
    ],
  };
}

const db = await connectDb();
const stats = {};
async function fillStore(handle) {
  const s = (stats[handle] = { created: 0, errors: 0, sample: null });
  const have = Number(
    (
      await db.query(
        "select count(*) n from bulk_shopify_fill where store=$1",
        [handle],
      )
    ).rows[0].n,
  );
  let room = Math.min(perStore - have, limit);
  if (room <= 0) {
    log(handle, `cap reached (${have}/${perStore})`);
    return;
  }
  const snack = /^snackbox/.test(handle);
  const { rows } = await db.query(
    `with have as (${HAVE_PER_CATEGORY}),
     pool as (
       select p.*, ${FAIR_RANK} as fair_rank
         from bulk_products p
         left join have h on h.category = p.category
         left join bulk_shopify_fill f on f.sku = p.sku and f.store = $1
        where p.source = 'open_food_facts' and f.sku is null and p.category is not null
          and p.category <> all($2::text[])
          and p.title <> '' and p.price is not null and p.sku ~ '^[0-9]{6,14}$'
          and ${snack ? "p.category = any($3::text[])" : "p.category <> all($3::text[])"}
          and not exists (select 1 from bulk_shopify_fill f2 where f2.sku = p.sku))   -- a product lives in one store
     select * from pool order by fair_rank, category, sku limit $4`,
    [handle, JUNK, SNACK, room],
  );
  log(handle, `have ${have}, adding up to ${rows.length}`);
  const done = [];
  const flush = async () => {
    if (!done.length) return;
    await db.query(
      "insert into bulk_shopify_fill(store, sku, product_gid) select $1, unnest($2::text[]), unnest($3::text[]) on conflict do nothing",
      [handle, done.map((d) => d[0]), done.map((d) => d[1])],
    );
    done.length = 0;
  };
  for (const p of rows) {
    if (Date.now() > deadline) {
      log(handle, "time budget reached; re-run to continue");
      break;
    }
    if (args.dry) {
      s.created++;
      if (s.created <= 2) console.log(JSON.stringify(toInput(p)).slice(0, 400));
      continue;
    }
    try {
      const d = await gql(handle, MUTATION, {
        input: toInput(p),
        id: { handle: `off-${p.sku}` },
      });
      const errs = d.productSet.userErrors;
      if (errs?.length) {
        s.errors++;
        s.sample ??= JSON.stringify(errs[0]);
        continue;
      }
      done.push([p.sku, d.productSet.product.id]);
      s.created++;
      if (done.length >= 25) await flush();
    } catch (e) {
      s.errors++;
      s.sample ??= String(e.message).slice(0, 200);
      if (s.errors > 25 && s.created === 0) break;
    }
  }
  await flush();
  log(
    handle,
    `created ${s.created}, errors ${s.errors}${s.sample ? ` (first: ${s.sample})` : ""}`,
  );
}

// ---------- non-food: the UCI Online Retail II catalogue ----------
//
// Every Open Food Facts row is food, so no ordering of it can make a store look like
// anything but a grocer. These 4,721 rows are the only non-food catalogue in Tiger,
// and they are the only one whose prices are real rather than generated. They were
// invisible to the loader because its candidate filter requires a `^[0-9]{6,14}$`
// barcode and UCI stock codes are alphanumeric ("85023C"), so none of the 4,721
// matched.
//
// They go to the five supplier stores, which hold 25-66 products each against
// BaseGoods' and SnackBox's 20,000. Each store leads with the category that matches
// what it actually makes; "Home & gifts" is over half the corpus and is dealt out
// afterwards to whichever store is smallest, which lands them all on one headcount.
const UCI_ROUTES = {
  packship: ["Storage & bags", "Kitchen & dining"],
  printpress: ["Stationery & wrap", "Seasonal"],
  laserlab: ["Lighting & candles"],
  stitchworks: [],
  threadforge: [],
};
// UCI is a UK dataset priced in GBP and every dev store settles in CAD, so the price
// is converted rather than pasted. Same rate as rox_data/pipeline/config.mjs FX_TO_CAD.
const GBP_TO_CAD = 1 / 0.58;
const roleOf = (handle) => handle.replace(/-[a-z0-9]+$/, "");
// UCI titles are uppercase inventory strings; the admin reads better in title case.
const titleCase = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());

function toUciInput(p) {
  const title = titleCase(p.title);
  const price = (Number(p.price) * GBP_TO_CAD).toFixed(2);
  return {
    handle: `uci-${String(p.sku).toLowerCase()}`,
    title: title.slice(0, 250),
    vendor: "Online Retail",
    productType: (p.category || "General merchandise").slice(0, 100),
    status: "ACTIVE",
    tags: [
      "MOLECULE_DEMO",
      "uci-online-retail",
      // The listed price is real; only the currency conversion is ours. Both facts
      // are on the product so neither is mistaken for the other.
      "real-price",
      "price-converted-gbp-cad",
      p.category && `cat:${p.category}`.slice(0, 40),
    ].filter(Boolean),
    descriptionHtml: `<p>${esc(title)}.</p><p><small>Source: UCI Online Retail II. Listed at £${Number(p.price).toFixed(2)} GBP, shown here converted to CAD.</small></p>`,
    productOptions: [{ name: "Size", values: [{ name: "Standard" }] }],
    variants: [
      {
        optionValues: [{ optionName: "Size", name: "Standard" }],
        price,
        sku: `UCI-${p.sku}`,
      },
    ],
  };
}

/** Deal the UCI rows out to the supplier stores: lead categories first, then balance. */
function assignUci(rows, handles) {
  const byStore = new Map(handles.map((h) => [h, []]));
  const lead = new Map();
  for (const h of handles)
    for (const cat of UCI_ROUTES[roleOf(h)] ?? []) lead.set(cat, h);

  const spare = [];
  for (const p of rows) {
    const h = lead.get(p.category);
    if (h && byStore.has(h)) byStore.get(h).push(p);
    else spare.push(p);
  }
  // Smallest store takes the next row, so the stores converge on equal totals
  // regardless of how lopsided the lead categories are.
  spare.sort((a, b) => (a.sku < b.sku ? -1 : 1));
  for (const p of spare) {
    let smallest = null;
    for (const [h, list] of byStore)
      if (!smallest || list.length < byStore.get(smallest).length) smallest = h;
    byStore.get(smallest).push(p);
  }
  return byStore;
}

// ---------- bulk mode: Shopify runs the mutations server-side, no client process has to stay alive ----------
const BULK_MUTATION = MUTATION.replace(/\s+/g, " ").trim();
const batchSize = Number(args.batch ?? 10000);

// Round-robin across categories instead of straight popularity. Ordering by
// `scans desc` spends a whole batch on the handful of huge categories: six of
// BaseGoods' 2,041 categories hold 78% of its rows, so 793 small categories stayed
// nearly empty. Ranking within each category and ordering by that rank takes one
// product from every category before it takes a second from any, which exhausts the
// small categories first and throttles the giants - a max-min fair split.
//
// The rank starts at however many of that category are already in the store, so the
// target is the FINAL headcount, not the increment. A category that earlier
// popularity-ordered runs already over-filled begins deep in the order and waits
// while the rest catch up. `scans desc` still decides which products win inside a
// category, so the popular ones go first where it does not cost diversity.
const FAIR_RANK = `coalesce(h.n, 0) + row_number() over (
       partition by p.category order by p.scans desc nulls last, p.sku)`;
const HAVE_PER_CATEGORY = `select p.category, count(*) n
       from bulk_products p join bulk_shopify_fill f on f.sku = p.sku
      where p.source = 'open_food_facts' group by 1`;

async function candidates(handle, n) {
  const snack = /^snackbox/.test(handle);
  return (
    await db.query(
      `with have as (${HAVE_PER_CATEGORY}),
     pool as (
       select p.*, ${FAIR_RANK} as fair_rank
         from bulk_products p left join have h on h.category = p.category
        where p.source = 'open_food_facts' and p.category is not null and p.category <> all($1::text[])
          and p.title <> '' and p.price is not null and p.sku ~ '^[0-9]{6,14}$'
          and ${snack ? "p.category = any($2::text[])" : "p.category <> all($2::text[])"}
          and not exists (select 1 from bulk_shopify_fill f where f.sku = p.sku))
     select * from pool order by fair_rank, category, sku limit $3`,
      [JUNK, SNACK, n],
    )
  ).rows;
}

async function submitBulk(handle) {
  const open = (
    await db.query(
      "select count(*) n from bulk_shopify_ops where store=$1 and collected_at is null",
      [handle],
    )
  ).rows[0].n;
  if (Number(open) > 0)
    return log(
      handle,
      `${open} bulk operation(s) still open: run --collect first`,
    );
  const have = Number(
    (
      await db.query(
        "select count(*) n from bulk_shopify_fill where store=$1",
        [handle],
      )
    ).rows[0].n,
  );
  const n = Math.min(batchSize, perStore - have);
  if (n <= 0) return log(handle, `cap reached (${have}/${perStore})`);
  const rows = await candidates(handle, n);
  if (!rows.length) return log(handle, "no more candidate products");
  return stageAndRun(handle, rows, (p) => ({
    input: toInput(p),
    id: { handle: `off-${p.sku}` },
  }));
}

/** Stage a JSONL of productSet variables and hand it to Shopify to run server-side. */
async function stageAndRun(handle, rows, build) {
  const jsonl = rows.map((p) => JSON.stringify(build(p))).join("\n") + "\n";
  if (args.dry)
    return log(
      handle,
      `dry: would submit ${rows.length} products (${(jsonl.length / 1e6).toFixed(1)} MB)`,
    );
  const up = await gql(
    handle,
    `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url parameters { name value } } userErrors { field message } } }`,
    {
      input: [
        {
          resource: "BULK_MUTATION_VARIABLES",
          filename: "products.jsonl",
          mimeType: "text/jsonl",
          httpMethod: "POST",
        },
      ],
    },
  );
  if (up.stagedUploadsCreate.userErrors?.length)
    throw new Error(JSON.stringify(up.stagedUploadsCreate.userErrors));
  const target = up.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append(
    "file",
    new Blob([jsonl], { type: "text/jsonl" }),
    "products.jsonl",
  );
  const put = await fetch(target.url, { method: "POST", body: form });
  if (!put.ok)
    throw new Error(
      `staged upload failed: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`,
    );
  const key = target.parameters.find((p) => p.name === "key").value;
  const run = await gql(
    handle,
    `mutation($m: String!, $p: String!) { bulkOperationRunMutation(mutation: $m, stagedUploadPath: $p) { bulkOperation { id status } userErrors { field message } } }`,
    { m: BULK_MUTATION, p: key },
  );
  const r = run.bulkOperationRunMutation;
  if (r.userErrors?.length) throw new Error(JSON.stringify(r.userErrors));
  const opId = r.bulkOperation.id;
  await db.query(
    "insert into bulk_shopify_ops(op_id, store, line_count) values($1,$2,$3)",
    [opId, handle, rows.length],
  );
  await db.query(
    "insert into bulk_shopify_fill(store, sku, op_id) select $1, unnest($2::text[]), $3 on conflict do nothing",
    [handle, rows.map((p) => p.sku), opId],
  );
  log(
    handle,
    `submitted ${rows.length} products as ${opId} (${r.bulkOperation.status})`,
  );
}

/** One pass over the whole UCI catalogue: assign, then submit one bulk op per store. */
async function submitUci(handles) {
  const targets = handles.filter((h) => roleOf(h) in UCI_ROUTES);
  if (!targets.length)
    return log("uci", "none of the requested stores take non-food products");
  const open = (
    await db.query(
      "select count(*) n from bulk_shopify_ops where store = any($1::text[]) and collected_at is null",
      [targets],
    )
  ).rows[0].n;
  if (Number(open) > 0)
    return log(
      "uci",
      `${open} bulk operation(s) still open: run --collect first`,
    );

  const { rows } = await db.query(
    `select * from bulk_products
      where source = 'uci_online_retail_ii' and title <> '' and price is not null
        and not exists (select 1 from bulk_shopify_fill f where f.sku = bulk_products.sku)
      order by sku`,
  );
  if (!rows.length) return log("uci", "no more candidate products");

  const byStore = assignUci(rows, targets);
  for (const [handle, list] of byStore) {
    if (!list.length) continue;
    const mix = [...new Set(list.map((p) => p.category))].join(", ");
    log(handle, `${list.length} non-food products (${mix})`);
    await stageAndRun(handle, list, (p) => ({
      input: toUciInput(p),
      id: { handle: `uci-${String(p.sku).toLowerCase()}` },
    }));
  }
}

async function collectBulk(handle) {
  const ops = (
    await db.query(
      "select op_id, line_count from bulk_shopify_ops where store=$1 and collected_at is null order by submitted_at",
      [handle],
    )
  ).rows;
  for (const op of ops) {
    const d = await gql(
      handle,
      `query($id: ID!) { bulkOperation(id: $id) { id status errorCode objectCount url partialDataUrl } }`,
      { id: op.op_id },
    );
    const b = d.bulkOperation;
    if (!b) {
      log(handle, op.op_id, "not found");
      continue;
    }
    if (["CREATED", "RUNNING"].includes(b.status)) {
      log(
        handle,
        `${op.op_id} ${b.status}: ${b.objectCount}/${op.line_count} done`,
      );
      continue;
    }
    const url = b.url || b.partialDataUrl;
    let ok = 0,
      bad = 0;
    if (url) {
      const text = await (await fetch(url)).text();
      const skus = [],
        gids = [];
      for (const line of text.split("\n").filter(Boolean)) {
        const ps = JSON.parse(line).data?.productSet;
        if (ps?.product?.id) {
          ok++;
          // Shopify lowercases handles, and UCI stock codes carry letters
          // ("85023C" -> "uci-85023c"), so the sku is recovered case-insensitively.
          skus.push(String(ps.product.handle).replace(/^(?:off|uci)-/, ""));
          gids.push(ps.product.id);
        } else bad++;
      }
      // one round trip per 2,000 products instead of one per product
      for (let i = 0; i < skus.length; i += 2000) {
        await db.query(
          "update bulk_shopify_fill f set product_gid = t.gid, error = null from (select unnest($2::text[]) as sku, unnest($3::text[]) as gid) t where f.store = $1 and lower(f.sku) = t.sku",
          [handle, skus.slice(i, i + 2000), gids.slice(i, i + 2000)],
        );
      }
    }
    const noResult = op.line_count - ok - bad;
    if (noResult > 0 && b.status !== "COMPLETED") bad += noResult;
    // anything from this op that never got a product id is marked failed (kept so it is not re-submitted forever)
    await db.query(
      "update bulk_shopify_fill set error=$3 where store=$1 and op_id=$2 and product_gid is null",
      [handle, op.op_id, `bulk op ${b.status} ${b.errorCode ?? ""}`.trim()],
    );
    await db.query(
      "update bulk_shopify_ops set status=$2, collected_at=now(), ok_count=$3, error_count=$4 where op_id=$1",
      [op.op_id, b.status, ok, bad],
    );
    log(handle, `${op.op_id} ${b.status}: ok ${ok}, errors ${bad}`);
  }
}

try {
  if (args.uci && !args.collect) await submitUci(stores);
  else
    await Promise.all(
      stores.map((h) =>
        args.collect
          ? collectBulk(h)
          : args.bulk
            ? submitBulk(h)
            : fillStore(h),
      ),
    );
} finally {
  const t = (
    await db.query(
      "select store, count(*) n from bulk_shopify_fill group by 1 order by 1",
    )
  ).rows;
  log("filled per store:", JSON.stringify(t));
  await db.end();
}
