# Backboard Owner Task

## Scope

Own `services/merchant-agents/**`, `packages/backboard/**`, merchant-agent UI components, and their tests. Do not mutate Shopify or redefine canonical claims.

## First deliverable

Build real and mock adapters, one assistant per merchant, one thread per merchant/order, typed quote handling, and a bounded safe tool-call loop. Mutating tools require `traceId`, `orderId`, and `actionKey`; live capacity must come from a tool rather than memory.

## Definition of done

- Adapter responses parse through shared contracts.
- Malformed output and timeouts have deterministic fallback behavior.
- A test proves persistent merchant memory can affect a new order while live capacity still comes from a tool.
