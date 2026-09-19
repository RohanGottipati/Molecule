# Shopify Status

> Integration note (2026-09-19): this is the historical Shopify workstream record.
> The merged catalog/mock API is exported from `@molecule/shopify/catalog`.
> The durable orchestration adapter remains at `@molecule/shopify`.
> See `docs/SHOPIFY_RELEASE.md` and `docs/RELEASE.md` for current runtime behavior.
> Unchecked tasks below remain roadmap items, not verified release capabilities.

Human-readable snapshot. The authoritative, checkbox-level task tracker is [`docs/TASKS/SHOPIFY_LOOP.md`](../../../docs/TASKS/SHOPIFY_LOOP.md) §3 (T1–T16), which a Claude Code loop works through directly — don't fork a second checklist here, just summarize it. Overwrite this file in place as state changes; use `CHANGELOG.md` for history.

_Last updated: 2026-09-19_

## Big picture

8 Shopify dev stores exist in one org, app installed on all 8, auth verified, ~797 synthetic products/~2,200 variants seeded and tagged `MOLECULE_DEMO`. API pinned to `2026-07`. Granted scopes: `read/write_products`, `read/write_draft_orders`, `read/write_inventory`, `read_orders`, `read_locations`. **Not granted:** `write_publications` (no Online Store channel — so no Hydrogen/storefront detour, demo through Admin), `write_files` (no product images), `read_customers`.

The hero demo moment (per `SHOPIFY_LOOP.md`): a judge edits a supplier's inventory/capacity live in Shopify Admin and watches Molecule's plan self-heal — a replacement supplier job appears in a different store.

## Task tracker state (mirrors `SHOPIFY_LOOP.md` §3 — check that file for the live truth)

| Phase                     | Tasks   | State as of last read                                                         |
| ------------------------- | ------- | ----------------------------------------------------------------------------- |
| P0 foundation             | T1–T7   | All open (`[ ]`)                                                              |
| P1 self-heal wow          | T8–T10  | All open (`[ ]`)                                                              |
| P2 complexity/credibility | T11–T13 | T11, T13 open; **T12 (Global Catalog/MCP client) blocked (`[~]`)** on HUMAN-3 |
| P3 stretch                | T14–T16 | All open, only attempted if P0/P1 land                                        |

## Blockers only a human can clear (`SHOPIFY_LOOP.md` §4)

- HUMAN-1: select the Shopify prize on Devpost before Sat 2:00pm EDT — **confirmed handled (2026-09-19)**.
- HUMAN-2: clear `.git/index.lock` if it reappears; push branch `shopify` and open a PR.
- HUMAN-3: create the Global Catalog API key (Dev Dashboard → Catalogs) and add `SHOPIFY_CATALOG_API_KEY` to `.env` — unblocks T12.
- HUMAN-4: share `SHOPIFY_CLIENT_ID` / `SHOPIFY_API_SECRET` / `SHOPIFY_STORES` with teammates privately (not via git); Admin UI invites are blocked by the dev-plan user limit.
- HUMAN-5: create + install the app on 4 extra dev stores, add handles to `SHOPIFY_STORES`, then `seed-shopify.mjs --store=<handle>`.
- HUMAN-6: provide a stable public URL for webhooks (tunnel or deploy), set in `shopify.app.toml` — needed for T8's webhook half.
- HUMAN-7 (optional): fix app name typo "Moecule" → "Molecule".
- HUMAN-8: record the backup demo video (Admin refresh + three-stores-side-by-side screenshot).

## Docs-owner note

This session (docs/research, not implementation) maintains `apps/shopify-app/docs/*` alongside the loop's own T1–T16 execution. See `COMPETITIVE_STRATEGY.md` for researched judging-criteria alignment and any gaps found that aren't yet covered by T1–T16.
