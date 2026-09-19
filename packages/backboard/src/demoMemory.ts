/**
 * B5 item 71: the demo-prep merchant correction. Seeded once via
 * MerchantTwinService.ensureMerchantMemory so it survives across every order
 * thread for the merchant, then recalled (never re-derived from the model)
 * on every later quote request.
 */
export const DEMO_RUSH_LIMIT_MEMORY_NOTE =
  "Never auto-accept rush embroidery above 40 units while machine #2 is down.";

export function buildDemoMerchantMemory(): string[] {
  return [DEMO_RUSH_LIMIT_MEMORY_NOTE];
}
