# Shopify Owner Task

## Scope

Own `apps/shopify-app/**`, `packages/shopify/**`, Shopify-specific scripts, and their tests. Do not implement business orchestration or alter shared contracts without coordination.

## First deliverable

Create `ShopifyAdapter`, `RealShopifyAdapter`, and deterministic `MockShopifyAdapter` implementations. Pin Admin GraphQL to `2026-07`; persist store sessions server-side; add sanitized provider verification; test idempotent composite-product creation. All mutations require `traceId` and `actionKey`.

## Definition of done

- Mock tests pass and retrying an action does not duplicate resources.
- A credentialed smoke test can query each configured store's name.
- No secret reaches browser code, fixtures, or logs.
- Provider/API deviations are documented.
