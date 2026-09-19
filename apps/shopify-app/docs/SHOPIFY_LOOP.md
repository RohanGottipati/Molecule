# Molecule OS: Shopify workstream, loop brief for Claude Code

Owner: Emaad (Person 1, Shopify). Repo branch: `shopify`. Written Sat Sep 19 2026.
Hard deadlines (EDT): Devpost Shopify prize must be selected before Sat 2:00pm. Submission closes Sun 8:00am.

Goal: win "Shopify: Hack Shopping with AI" (1 winner; Technical Excellence, Impact, Innovation). Molecule sits on the merchant side: a vague request becomes a certified plan across multiple merchant stores, and the plan lands as REAL state in Shopify Admin (products, draft orders, inventory). The hero moment is a judge editing inventory in real Admin and watching the plan self-heal.

---

## 0. Read first (do this every run)

1. `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`, `docs/TASKS/SHOPIFY.md`, `docs/DEMO_RUNBOOK.md`.
2. This file. Pick the FIRST unchecked `[ ]` task in section 3 whose dependencies are done.

## 1. Current state (already done, do not redo)

- 8 Shopify dev stores exist in one Dev Dashboard organization, the app "Moecule" (typo, cosmetic) is installed on all 8, and all authenticate. API version pinned to `2026-07`.
- Store handles (subdomain before `.myshopify.com`), role = text before the first `-`:
  `molecule-storefront`, `stitchworks-7gw6fagb`, `threadforge-eznglsyk`, `basegoods-tyefhh8o`, `laserlab-yprjwhc5`, `packship-5lfaj5qq`, `snackbox-0hubj57j`, `printpress-b9oy1d5n`.
- Granted app scopes: `read/write_products`, `read/write_draft_orders`, `read/write_inventory`, `read_orders`, `read_locations`. NOT granted: `write_publications` (so products are not on the Online Store channel), `write_files` (no images), `read_customers`.
- Seeded 797 synthetic products / about 2,200 variants, all tagged `MOLECULE_DEMO` (plus `merchant:<role>` and `kind:<kind>` tags). Counts: BaseGoods 438, SnackBox 93, PackShip 65, PrintPress 57, LaserLab 51, StitchWorks 25, ThreadForge 33, Molecule Storefront 35 (plus Shopify sample snowboards).
- Capacity is modeled as TRACKED inventory: products named "... Capacity - Units per Day" (or "Pieces per Day"). Seed values: StitchWorks 20, ThreadForge 180, LaserLab 250, PrintPress 3000. Setting one to 0 in Admin is the demo failure trigger. PackShip capacity is stocked packaging goods.
- Deliberate data traps for the solver: one cotton-free polyester hoodie in BaseGoods, SnackBox items tagged `allergens:unverified`, mixed lead-time phrasing ("24 business hours" vs "1 day") in PackShip.
- Scripts (in `scripts/`): `seed-data.mjs` (deterministic catalogs), `seed-shopify.mjs` (idempotent productSet upsert by handle, resumable, flags `--store --limit --budget --concurrency --dry --wipe`), `verify-shopify.mjs` (auth check for every store).
  Run: `node --env-file=.env scripts/verify-shopify.mjs`.
- `.env` (gitignored) has `SHOPIFY_CLIENT_ID`, `SHOPIFY_API_SECRET` (the client secret), `SHOPIFY_STORES` (comma list), `MOLECULE_STOREFRONT_DOMAIN`, plus other teammates' keys.
- Auth: client credentials grant. `POST https://{shop}.myshopify.com/admin/oauth/access_token` with `grant_type=client_credentials`, client id and secret gives a 24h token. Works only for stores in the same organization.

## 2. Rules (guardrails for the loop)

- NEVER print, log, commit or echo any secret or token. Never `cat .env`. Read env vars in code only.
- Do NOT run `seed-shopify.mjs --wipe` and do NOT run any bulk delete against stores unless a task says so.
- Do NOT `git push`, force anything, or edit other people's packages (`services/*`, `packages/{backboard,db,openai,events}`). Stay in `packages/shopify`, `apps/shopify-app`, `scripts/`, `docs/TASKS/SHOPIFY*`, and Shopify-related fixtures. Make small commits on branch `shopify`, stage files by name (never `git add .`).
- Contracts first: implement against `docs/CONTRACTS.md` and `packages/contracts`. If the contract is missing something, add a minimal, additive change and note it in your commit message. Do not rename existing fields.
- Only the orchestrator calls the Shopify adapter. Shopify reads become Tiger claims of type SHOPIFY_SNAPSHOT. The solver alone certifies plans, so the adapter never decides feasibility.
- Every write is idempotent by an `actionKey`. Before calling Shopify, record a "pending" row (or in-memory equivalent for the mock) and after the call store the returned GID. Do NOT dedupe by searching draft orders by tag (Shopify's search index lags by seconds).
- Send FULL list state on `productSet` (omitted variants/options/metafields are deleted). Do not send `DraftOrderLineItem.grams` (removed in 2026-07; use `weight`).
- GraphQL: retry with backoff on `THROTTLED` and HTTP 429 or 5xx; check `extensions.cost.throttleStatus`.
- Be honest in copy: "synthetic merchants on real Shopify infrastructure". Never fake payout splits.
- MockShopifyAdapter must work with NO network and NO env, so teammates can build against it.
- If a task is blocked (needs a secret, a browser action, or a human decision), change its `[ ]` to `[~]` and add `BLOCKED: <reason>` in section 3, move on to the next task, and do not retry it in a loop. (The `[~]` marker is what lets the shell loop terminate.)

## 3. Tasks (check off with `[x]` when the acceptance line passes; add a one-line note)

### P0: foundation, unblock teammates

- [ ] **T1. Commit the seed scripts.** Files: `scripts/seed-data.mjs`, `scripts/seed-shopify.mjs`, `scripts/verify-shopify.mjs`, `.env.example`. If `.git/index.lock` exists and no git process is running, mention it and mark BLOCKED (human removes it). Accept: `git status` clean for those files, one commit.
- [ ] **T2. Adapter interface plus MockShopifyAdapter** in `packages/shopify`. Methods (align names with `docs/CONTRACTS.md` if they exist): `getSnapshot(shop)`, `listMerchantCapacity()`, `searchCatalog(filters)`, `upsertCompositeProduct(plan)`, `createSupplierJob(planNode)`, `supersedeJob(jobId, reason)`, `createCustomerCheckout(plan)` (returns an `invoiceUrl`-shaped value), `demoAdjustInventory(shop, sku|itemId, qty)`, `reset()`. The mock is in-memory and deterministic, and loads the SAME seed catalogs from `scripts/seed-data.mjs` (import or copy into a shared fixture in `packages/test-fixtures`). Accept: unit tests cover idempotent retry (same actionKey twice gives one product and one draft) and `demoAdjustInventory` changing what `getSnapshot` reports.
- [ ] **T3. Real adapter core.** Token cache per shop (client credentials, refresh 60s before expiry), `gql()` with retry/backoff and cost awareness, `locationId` lookup, typed errors. Accept: an integration test (skipped unless env vars are set) that authenticates to all 8 stores and reads capacity quantities.
- [ ] **T4. Snapshot and catalog index.** Read every supplier's capacity items and inventory into `SHOPIFY_SNAPSHOT` shaped data (shop, role, capacity per day, stock per SKU, price, lead-time text). Build a local JSON cache/index of all products (fetch by paginating `products(first:250)` filtered by `tag:MOLECULE_DEMO`) so search is instant and not subject to Shopify search lag. Accept: `node scripts/snapshot-shopify.mjs` writes `.cache/shopify-snapshot.json` (gitignored) with 8 stores and about 797 products in under 60 seconds; the mock returns the same shape.
- [ ] **T5. Composite product writer.** `upsertCompositeProduct` uses `productSet` with `identifier: {handle: "molecule-{orderId}-v{intentVersion}"}`, options and variants with price, plus metafields: `planId`, `orderId`, `riskScore`, `p95`, `provenance` (short summary of which suppliers and why). Create metafield DEFINITIONS first (only defined metafields show in Admin). Verify the `productSet` sku placement and metafield input shape against the 2026-07 schema (use `graphql_schema` introspection if the Shopify MCP is available, otherwise a one-product probe). Accept: running it twice yields one product in the Molecule Storefront and metafields visible via API.
- [ ] **T6. Supplier jobs and customer checkout.** `createSupplierJob` = one `draftOrderCreate` per plan node in that supplier's store with tags (`MOLECULE_JOB`, `plan:<id>`, `node:<id>`) and custom attributes; `supersedeJob` adds tag `MOLECULE_SUPERSEDED` (does not delete) and the orchestrator creates the replacement; `createCustomerCheckout` = `draftOrderCreate` with a custom line item on the storefront and return `invoiceUrl`. Accept: integration test creates then supersedes a job and reads tags back; retry with the same actionKey creates nothing new.
- [ ] **T7. demo reset.** `scripts/demo-reset.mjs` (and wire a `demo:reset` script only if `package.json` already has a scripts block for it; otherwise document the command): restore all capacity items to seed values, delete or supersede all drafts tagged `MOLECULE_JOB` / `MOLECULE_SUPERSEDED`, delete composite products with handle prefix `molecule-` and tag `MOLECULE_PLAN`, and finish in under 60 seconds. Idempotent. Accept: run it 3 times in a row against the real stores with no errors.

### P1: the "wow" (self-heal loop)

- [ ] **T8. Inventory change detection.** Polling first (every 5 to 10s, diff capacity items against the last snapshot, emit `SHOPIFY_INVENTORY_CHANGED {shop, itemId, from, to}`). Then a webhook handler for `inventory_levels/update`: verify `X-Shopify-Hmac-SHA256` against the RAW body before JSON parsing, return 200 immediately (5s budget), dedupe on `X-Shopify-Webhook-Id`, route on `X-Shopify-Shop-Domain`, process asynchronously, and share the same event type as polling. Declare the subscription in `apps/shopify-app/shopify.app.toml` (needs a stable public URL, see HUMAN-6). Accept: unit tests for HMAC (valid, invalid, tampered body) and dedupe; a script `scripts/demo-adjust.mjs <shop> <capacity item> <qty>` changes inventory and the poller emits the event within 15s.
- [ ] **T9. Demo hooks.** `demoAdjustInventory` via `inventorySetQuantities` (verify the 2026-07 input shape), the `/api/chaos` backup button contract with the web app (coordinate through `docs/CONTRACTS.md`, do not edit `apps/web`), and a `scripts/demo-scenario.md` with the exact 90-second Shopify cut: (1) merchant pain, (2) Admin empty, (3) run, (4) refresh Admin (composite product plus drafts in two stores), (5) judge sets a supplier's capacity to 0 in Admin, (6) replacement job appears in another store.
- [ ] **T10. Tests.** Full unit suite for mock plus real-adapter pure logic, and a gated integration suite. Accept: `pnpm test` (or the repo's test command) passes for `packages/shopify` with no network.

### P2: more complexity and credibility

- [ ] **T11. Four more store profiles** in `seed-data.mjs` (data only, do NOT create stores): a cheaper-but-slower blanks supplier, a cheaper packaging supplier with longer lead times and higher minimum quantities, a rush/premium engraving or embroidery supplier (about 2x price, 24h turnaround, small capacity), and a fulfilment/kitting supplier. Add heterogeneous lead times, MOQs, price breaks, a few out-of-stock variants. Keep `roleForStore` working. Accept: `node --check` passes and the dry run prints per-role counts. (Store creation is HUMAN-5.)
- [~] **T12. Global Catalog client** (`packages/shopify/src/catalog.ts`): token from `https://api.shopify.com/auth/access_token`, MCP/Catalog endpoint `https://catalog.shopify.com/api/ucp/mcp`, a `verify:catalog` script. Start as `[~]` BLOCKED until HUMAN-3 is done, then flip it back to `[ ]`. It returns only existing listings (no capacity or lead time), so use it for "real product breadth", not for feasibility.
- [ ] **T13. Docs.** Update `docs/TASKS/SHOPIFY.md`, add a "How we use Shopify" section (Admin GraphQL 2026-07, dev stores, client credentials grant, productSet, draftOrderCreate, metafields, webhooks, idempotency), the DEMO_RUNBOOK Shopify cut, and a list of screenshots to capture.

### P3: stretch (only if P0 and P1 are done)

- [ ] **T14.** "Why this supplier" metafield card content (short, human-readable provenance per plan node).
- [ ] **T15.** SimGym-inspired demand check: about 20 LLM personas over generated product copy and price, output predicted buy/bounce with one suggested tweak. Label it "simulated". Do not touch the solver.
- [ ] **T16.** Embedded Polaris page in Admin (plan plus event feed).

## 4. Human-only items (the loop must NOT attempt these; they are not checkboxes)

- HUMAN-1 (before Sat 2:00pm EDT): select the Shopify prize on Devpost.
- HUMAN-2: remove `.git/index.lock` if it returns (`rm -f .git/index.lock`), then push branch `shopify` and open a PR.
- HUMAN-3: create the Global Catalog API key in Dev Dashboard, Catalogs, and add it to `.env` (suggest name `SHOPIFY_CATALOG_API_KEY`).
- HUMAN-4: teammates' access. Share `SHOPIFY_CLIENT_ID`, `SHOPIFY_API_SECRET`, `SHOPIFY_STORES` privately (not via git). Admin UI invites are blocked by the Basic dev plan user limit; collaborator requests are the workaround. Do not share the owner login.
- HUMAN-5: create and install the app on the 4 extra dev stores (browser steps), add the handles to `SHOPIFY_STORES`, then run `seed-shopify.mjs --store=<handle>`.
- HUMAN-6: provide a stable public URL for webhooks (tunnel or deploy) and set it in `shopify.app.toml`.
- HUMAN-7: fix the app name typo "Moecule" to "Molecule" by releasing a new version in the Dev Dashboard (optional).
- HUMAN-8: record the backup demo video including the Admin refresh, and capture the three-stores-side-by-side screenshot.

## 5. Risks to watch

- Storefront pages show Shopify's password page (dev stores cannot remove it), so demo through Admin and `invoiceUrl`.
- `productSet` and `inventorySetQuantities` input shapes in 2026-07 are unverified in places. Probe with one object before batching.
- Token expiry mid-demo: refresh logic must be tested once.
- Only cut in this order if time runs short: T16, T15, T14, T12. Never cut real Admin state, idempotency, or the self-heal loop.

---

## LOOP PROMPT (paste this into `claude -p`, or into `/loop`)

You are working on the Shopify workstream of the Molecule OS repo on branch `shopify`. Read AGENTS.md, docs/CONTRACTS.md, docs/TASKS/SHOPIFY.md, and docs/TASKS/SHOPIFY_LOOP.md (or SHOPIFY_LOOP.md at the repo root). Follow section 2 (Rules) strictly. Pick the FIRST `[ ]` task in section 3 whose dependencies are done (skip `[x]` done and `[~]` blocked). Implement it, run its acceptance check, fix failures, then mark it `[x]` with a one-line note in the file, and make ONE small commit on branch `shopify` staging files by name. If the task is blocked by something only a human can do, change `[ ]` to `[~]`, add `BLOCKED: <reason>`, and move to the next task. Never print secrets, never push, never wipe stores. Work on at most one task per run, then stop and print a 3-line status: task id, result, next task id. If no `[ ]` tasks remain, print `ALL DONE` and stop.

### Example shell loop (from the repo root)

```bash
FILE=docs/TASKS/SHOPIFY_LOOP.md
PROMPT="$(sed -n '/^## LOOP PROMPT/,/^### Example shell loop/p' "$FILE" | sed '1d;$d')"
for i in $(seq 1 20); do
  grep -q '^- \[ \]' "$FILE" || { echo "no open tasks"; break; }
  claude -p "$PROMPT" --max-turns 60 \
    --allowedTools "Read,Edit,Write,Glob,Grep,Bash(node:*),Bash(pnpm:*),Bash(git status:*),Bash(git diff:*),Bash(git add:*),Bash(git commit:*)" \
    | tee -a .loop.log
  grep -q "ALL DONE" .loop.log && break
  sleep 5
done
```

Notes: check `claude --help` for the exact flag names on your CLI version. Add `.loop.log` and `.cache/` to `.gitignore`. Do not use `--dangerously-skip-permissions` here, because the rules rely on the allow-list. A run that hits BLOCKED items will loop to the next task on its own.
