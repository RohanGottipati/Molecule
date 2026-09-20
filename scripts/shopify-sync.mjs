// Pull supplier data from every Shopify dev store into the Tiger/Postgres database.
//   node --env-file=.env --env-file=.env.local scripts/shopify-sync.mjs [--dry] [--store=<handle>] [--only=catalog|claims] [--include-storefront]
// Writes: shopify_products, shopify_variants, merchants, merchant_stores, raw_artifacts, canonical_claims,
// market_metrics, molecule_events, shopify_sync_runs. Idempotent: unchanged data inserts nothing new.
import {
  CAPACITY_SIGNALS,
  SHOPIFY_CLAIM_AUTHORITY,
  connectDb,
  gql,
  maskUrl,
  merchantIdForStore,
  parseArgs,
  sha256,
  stableJson,
  storeHandles,
  uuidFrom,
} from "./lib/molecule-env.mjs";

const args = parseArgs();
const dry = Boolean(args.dry);
const only = args.only; // catalog | claims | undefined
const runId = `sync-${new Date()
  .toISOString()
  .replace(/[-:.TZ]/g, "")
  .slice(0, 14)}`;
const PRODUCTS = `query($c:String){
  shop{ name currencyCode }
  products(first:15, after:$c){
    pageInfo{ hasNextPage endCursor }
    edges{ node{ id handle title productType vendor status tags description
      variants(first:100){ pageInfo{ hasNextPage endCursor } edges{ node{ id sku title price inventoryQuantity
        selectedOptions{ name value } inventoryItem{ id tracked } } } } } } } }`;

async function fetchStore(handle) {
  const products = [];
  let cursor = null,
    shop = null,
    truncatedVariants = 0;
  const productCursors = new Set();
  for (;;) {
    const d = await gql(handle, PRODUCTS, { c: cursor });
    shop = d.shop;
    for (const e of d.products.edges) {
      const seen = new Set();
      while (e.node.variants.pageInfo.hasNextPage) {
        const after = e.node.variants.pageInfo.endCursor;
        if (!after || seen.has(after)) throw new Error("CATALOG_PAGINATION_REQUIRED");
        seen.add(after);
        const next = await gql(handle, `query Variants($id:ID!,$after:String!){product(id:$id){variants(first:100,after:$after){
          pageInfo{hasNextPage endCursor} edges{node{id sku title price inventoryQuantity selectedOptions{name value} inventoryItem{id tracked}}}}}}`, {id:e.node.id,after});
        if (!next.product) throw new Error("CATALOG_PRODUCT_DISAPPEARED");
        e.node.variants.edges.push(...next.product.variants.edges);
        e.node.variants.pageInfo = next.product.variants.pageInfo;
      }
      products.push(e.node);
    }
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
    if (!cursor || productCursors.has(cursor)) throw new Error("CATALOG_PAGINATION_REQUIRED");
    productCursors.add(cursor);
  }
  return { handle, shop, products, truncatedVariants };
}

async function upsertCatalog(db, s, merchantId, domain) {
  const productRows = s.products.map((p) => ({
    product_gid: p.id,
    shop_domain: domain,
    merchant_id: merchantId,
    handle: p.handle,
    title: p.title,
    product_type: p.productType || null,
    vendor: p.vendor || null,
    status: p.status,
    tags: p.tags,
    description: (p.description || "").slice(0, 2000),
  }));
  const variantRows = s.products.flatMap((p) =>
    p.variants.edges.map(({ node: v }) => ({
      variant_gid: v.id,
      product_gid: p.id,
      shop_domain: domain,
      merchant_id: merchantId,
      sku: v.sku || null,
      title: v.title,
      options: v.selectedOptions,
      price: v.price === null ? null : Number(v.price),
      currency: s.shop.currencyCode,
      tracked: Boolean(v.inventoryItem?.tracked),
      available: v.inventoryItem?.tracked ? v.inventoryQuantity : null,
      inventory_item_gid: v.inventoryItem?.id ?? null,
    })),
  );
  const chunk = (arr, n) =>
    Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
      arr.slice(i * n, i * n + n),
    );
  for (const part of chunk(productRows, 150)) {
    await db.query(
      `insert into shopify_products(product_gid,shop_domain,merchant_id,handle,title,product_type,vendor,status,tags,description,synced_at,run_id)
      select product_gid,shop_domain,merchant_id,handle,title,product_type,vendor,status,tags,description,now(),$2
      from jsonb_to_recordset($1::jsonb) as x(product_gid text,shop_domain text,merchant_id text,handle text,title text,product_type text,vendor text,status text,tags jsonb,description text)
      on conflict(product_gid) do update set shop_domain=excluded.shop_domain,merchant_id=excluded.merchant_id,handle=excluded.handle,title=excluded.title,
        product_type=excluded.product_type,vendor=excluded.vendor,status=excluded.status,tags=excluded.tags,description=excluded.description,synced_at=now(),run_id=excluded.run_id`,
      [JSON.stringify(part), runId],
    );
  }
  for (const part of chunk(variantRows, 300)) {
    await db.query(
      `insert into shopify_variants(variant_gid,product_gid,shop_domain,merchant_id,sku,title,options,price,currency,tracked,available,inventory_item_gid,synced_at)
      select variant_gid,product_gid,shop_domain,merchant_id,sku,title,options,price,currency,tracked,available,inventory_item_gid,now()
      from jsonb_to_recordset($1::jsonb) as x(variant_gid text,product_gid text,shop_domain text,merchant_id text,sku text,title text,options jsonb,price numeric,currency text,tracked boolean,available int,inventory_item_gid text)
      on conflict(variant_gid) do update set sku=excluded.sku,title=excluded.title,options=excluded.options,price=excluded.price,currency=excluded.currency,
        tracked=excluded.tracked,available=excluded.available,inventory_item_gid=excluded.inventory_item_gid,synced_at=now()`,
      [JSON.stringify(part)],
    );
  }
  const missing = await db.query(
    `update shopify_products set status='MISSING', synced_at=now() where shop_domain=$1 and run_id is distinct from $2 and status<>'MISSING'`,
    [domain, runId],
  );
  return {
    products: productRows.length,
    variants: variantRows.length,
    missing: missing.rowCount,
  };
}

async function ensureMerchant(db, merchantId, shopName, domain) {
  const m = await db.query("select 1 from merchants where merchant_id=$1", [
    merchantId,
  ]);
  let created = false;
  if (!m.rowCount) {
    await db.query(
      "insert into merchants(merchant_id,name,status,demo_tag) values($1,$2,'online','MOLECULE_DEMO')",
      [merchantId, shopName],
    );
    created = true;
  }
  const st = await db.query(
    "select 1 from merchant_stores where merchant_id=$1 and shopify_domain=$2",
    [merchantId, domain],
  );
  if (!st.rowCount)
    await db.query(
      "insert into merchant_stores(merchant_id,shopify_domain) values($1,$2)",
      [merchantId, domain],
    );
  return created;
}

async function emitClaims(db, s, merchantId, domain, now) {
  const results = [];
  for (const sig of CAPACITY_SIGNALS[merchantId] ?? []) {
    const product = s.products.find(
      (p) => p.tags.includes("capacity") && sig.title.test(p.title),
    );
    const variant = product?.variants.edges[0]?.node;
    if (!variant?.inventoryItem?.tracked) {
      results.push({
        capabilityId: sig.capabilityId,
        status: "no-signal-product",
      });
      continue;
    }
    const value = variant.inventoryQuantity;
    const field = `${sig.capabilityId}.capacity`;
    const reference = `shopify:${domain}:${variant.inventoryItem.id}`;
    const latest = await db.query(
      `select claim_id, normalized_value from canonical_claims where merchant_id=$1 and field=$2 and source_reference=$3 and resolution_status in ('active','conflicted') order by ingested_at desc limit 1`,
      [merchantId, field, reference],
    );
    if (latest.rows[0] && Number(latest.rows[0].normalized_value) === value) {
      results.push({
        capabilityId: sig.capabilityId,
        status: "unchanged",
        value,
      });
      continue;
    }
    if (dry) {
      results.push({
        capabilityId: sig.capabilityId,
        status: "would-insert",
        value,
        previous: latest.rows[0]
          ? Number(latest.rows[0].normalized_value)
          : null,
      });
      continue;
    }
    const input = {
      merchantId,
      field,
      rawValue: value,
      sourceKind: "shopify",
      sourceReference: reference,
      observedAt: now,
      sourceAuthority: SHOPIFY_CLAIM_AUTHORITY,
      extractionConfidence: 1,
      evidenceText: `Shopify Admin available inventory for "${product.title}" at ${domain}`,
    };
    const raw = stableJson(input);
    const checksum = sha256(raw);
    const artifactId = `artifact:${checksum}`;
    const claimId = sha256(stableJson({ ...input, sourceChecksum: checksum }));
    await db.query(
      "select merchant_id from merchants where merchant_id=$1 for update",
      [merchantId],
    );
    await db.query(
      "update canonical_claims set resolution_status='superseded' where merchant_id=$1 and field=$2 and source_reference=$3 and resolution_status in ('active','conflicted')",
      [merchantId, field, reference],
    );
    await db.query(
      `insert into raw_artifacts(artifact_id,merchant_id,source_kind,source_reference,checksum,raw_content) values($1,$2,'shopify',$3,$4,$5) on conflict(artifact_id) do nothing`,
      [artifactId, merchantId, reference, checksum, raw],
    );
    await db.query(
      `insert into canonical_claims(claim_id,merchant_id,field,normalized_value,normalized_unit,source_kind,source_reference,source_checksum,observed_at,ingested_at,source_authority,extraction_confidence,resolution_status,evidence_text)
      values($1,$2,$3,$4,null,'shopify',$5,$6,$7,$8,$9,$10,'active',$11) on conflict(claim_id) do nothing`,
      [
        claimId,
        merchantId,
        field,
        JSON.stringify(value),
        reference,
        checksum,
        now,
        now,
        SHOPIFY_CLAIM_AUTHORITY,
        1,
        input.evidenceText,
      ],
    );
    await db.query(
      `insert into molecule_events(event_id,trace_id,merchant_id,event_type,severity,source,ts,payload) values($1,$2,$3,'reality.claim.ingested','INFO','rox',$4,$5) on conflict(event_id) do nothing`,
      [
        uuidFrom(`ingest:${artifactId}`),
        `shopify-${runId}`,
        merchantId,
        now,
        JSON.stringify({
          artifactId,
          checksum,
          claimId,
          field,
          value,
          source: "shopify",
        }),
      ],
    );
    await db.query(
      "insert into market_metrics(ts,merchant_id,capability_id,metric,value) values($1,$2,$3,'capacity',$4)",
      [now, merchantId, sig.capabilityId, value],
    );
    results.push({
      capabilityId: sig.capabilityId,
      status: "inserted",
      value,
      previous: latest.rows[0] ? Number(latest.rows[0].normalized_value) : null,
    });
  }
  return results;
}

async function main() {
  const handles = storeHandles(args.store).filter(
    (h) => args["include-storefront"] || merchantIdForStore(h) !== "molecule",
  );
  if (!handles.length)
    throw new Error("No stores selected (SHOPIFY_STORES / --store)");
  console.log(
    `Shopify sync ${runId} ${dry ? "(dry run) " : ""}stores=${handles.length} db=${dry ? "(not connected)" : maskUrl(process.env.DATABASE_URL)}`,
  );
  const fetched = await Promise.all(handles.map((h) => fetchStore(h)));
  for (const s of fetched)
    console.log(
      `  fetched ${s.handle.padEnd(24)} ${String(s.products.length).padStart(4)} products ${String(s.products.reduce((n, p) => n + p.variants.edges.length, 0)).padStart(5)} variants ${s.shop.currencyCode}${s.truncatedVariants ? `  WARNING ${s.truncatedVariants} products have >30 variants (truncated)` : ""}`,
    );
  if (dry && only !== "claims") {
    console.log("dry run: catalog not written");
  }
  const db = dry ? null : await connectDb();
  const summary = { stores: [], claimsInserted: 0, claimsUnchanged: 0 };
  try {
    if (db)
      await db.query(
        "insert into shopify_sync_runs(run_id,stores) values($1,$2)",
        [runId, JSON.stringify(handles)],
      );
    const now = new Date().toISOString();
    for (const s of fetched) {
      const merchantId = merchantIdForStore(s.handle),
        domain = `${s.handle}.myshopify.com`;
      const line = { store: s.handle, merchantId };
      if (db) {
        await db.query("begin");
        try {
          line.merchantCreated = await ensureMerchant(
            db,
            merchantId,
            s.shop.name,
            domain,
          );
          if (only !== "claims")
            line.catalog = await upsertCatalog(db, s, merchantId, domain);
          if (only !== "catalog")
            line.claims = await emitClaims(db, s, merchantId, domain, now);
          await db.query("commit");
        } catch (e) {
          await db.query("rollback");
          throw e;
        }
      } else if (only !== "catalog")
        line.claims = await emitClaims(
          null ?? { query: async () => ({ rows: [], rowCount: 0 }) },
          s,
          merchantId,
          domain,
          now,
        );
      for (const c of line.claims ?? []) {
        if (c.status === "inserted") summary.claimsInserted++;
        if (c.status === "unchanged") summary.claimsUnchanged++;
      }
      summary.stores.push(line);
      console.log(
        `  ${dry ? "planned" : "synced "} ${s.handle.padEnd(24)} ${line.catalog ? `products=${line.catalog.products} variants=${line.catalog.variants} missing=${line.catalog.missing}` : ""} ${(line.claims ?? []).map((c) => `${c.capabilityId}:${c.status}${c.value !== undefined ? `=${c.value}` : ""}`).join(" ")}`,
      );
    }
    if (db) {
      await db.query(
        "update shopify_sync_runs set status='succeeded', finished_at=now(), counts=$2 where run_id=$1",
        [
          runId,
          JSON.stringify({
            stores: handles.length,
            claimsInserted: summary.claimsInserted,
            claimsUnchanged: summary.claimsUnchanged,
          }),
        ],
      );
      await db.query(
        `insert into molecule_events(event_id,trace_id,event_type,severity,source,ts,payload) values($1,$2,'shopify.sync.completed','INFO','shopify',now(),$3) on conflict(event_id) do nothing`,
        [
          uuidFrom(`sync:${runId}`),
          `shopify-${runId}`,
          JSON.stringify({
            runId,
            stores: handles.length,
            claimsInserted: summary.claimsInserted,
          }),
        ],
      );
    }
  } catch (e) {
    if (db)
      await db
        .query(
          "update shopify_sync_runs set status='failed', finished_at=now(), error=$2 where run_id=$1",
          [runId, String(e.message).slice(0, 500)],
        )
        .catch(() => {});
    throw e;
  } finally {
    await db?.end();
  }
  console.log(
    `done: claims inserted=${summary.claimsInserted} unchanged=${summary.claimsUnchanged}`,
  );
}
main().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
