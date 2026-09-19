#!/usr/bin/env node
// Fill Shopify dev stores with real Open Food Facts products (from bulk_products in Tiger). Resumable, rate-limit aware.
//
//   node --env-file=.env --env-file=.env.local scripts/bulk/shopify-catalog-fill.mjs --stores=snackbox,basegoods --per-store=5000 [--max-seconds=100] [--dry] [--limit=N]
//
//   --bulk       submit a Shopify bulk mutation per store (server-side, async; --batch=10000 products each)
//   --collect    poll open bulk operations and record their results in Tiger
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
    `select p.* from bulk_products p left join bulk_shopify_fill f on f.sku = p.sku and f.store = $1
     where p.source = 'open_food_facts' and f.sku is null and p.category is not null and p.category <> all($2::text[])
       and p.title <> '' and p.price is not null and p.sku ~ '^[0-9]{6,14}$'
       and ${snack ? "p.category = any($3::text[])" : "p.category <> all($3::text[])"}
       and not exists (select 1 from bulk_shopify_fill f2 where f2.sku = p.sku)   -- a product lives in one store
     order by p.scans desc nulls last, p.sku limit $4`,
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

// ---------- bulk mode: Shopify runs the mutations server-side, no client process has to stay alive ----------
const BULK_MUTATION = MUTATION.replace(/\s+/g, " ").trim();
const batchSize = Number(args.batch ?? 10000);

async function candidates(handle, n) {
  const snack = /^snackbox/.test(handle);
  return (
    await db.query(
      `select p.* from bulk_products p
     where p.source = 'open_food_facts' and p.category is not null and p.category <> all($1::text[])
       and p.title <> '' and p.price is not null and p.sku ~ '^[0-9]{6,14}$'
       and ${snack ? "p.category = any($2::text[])" : "p.category <> all($2::text[])"}
       and not exists (select 1 from bulk_shopify_fill f where f.sku = p.sku)
     order by p.scans desc nulls last, p.sku limit $3`,
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
  const jsonl =
    rows
      .map((p) =>
        JSON.stringify({ input: toInput(p), id: { handle: `off-${p.sku}` } }),
      )
      .join("\n") + "\n";
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
          skus.push(String(ps.product.handle).replace(/^off-/, ""));
          gids.push(ps.product.id);
        } else bad++;
      }
      // one round trip per 2,000 products instead of one per product
      for (let i = 0; i < skus.length; i += 2000) {
        await db.query(
          "update bulk_shopify_fill f set product_gid = t.gid, error = null from (select unnest($2::text[]) as sku, unnest($3::text[]) as gid) t where f.store = $1 and f.sku = t.sku",
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
  await Promise.all(
    stores.map((h) =>
      args.collect ? collectBulk(h) : args.bulk ? submitBulk(h) : fillStore(h),
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
