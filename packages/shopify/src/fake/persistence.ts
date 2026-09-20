import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { FakeShopifyAdmin, type FakeShopifyAdminOptions } from "./admin.js";
import { normalizeDomain } from "./state.js";

/**
 * Cross-process continuity for the fake stores.
 *
 * The catalog itself is always regenerated from the deterministic fixtures, so the fake world
 * is reproducible and never drifts. Only *mutations* are persisted, as a small overlay. That
 * is what makes the capacity self-heal demo work across separate script invocations:
 * `shopify-set-capacity.mjs` and `shopify-sync.mjs` are different processes, and without an
 * overlay the edit would vanish between them.
 *
 * The overlay holds no credentials and no provider secrets.
 */

const OverlaySchema = z.object({
  version: z.literal(1),
  updatedAt: z.iso.datetime(),
  inventory: z
    .array(
      z.object({
        domain: z.string(),
        inventoryItemId: z.string(),
        quantity: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});
export type FakeOverlay = z.infer<typeof OverlaySchema>;

export function overlayPath(
  dataDir = process.env.DATA_DIR ?? ".molecule-data",
): string {
  return join(dataDir, "fake-shopify", "overlay.json");
}

export function readOverlay(path = overlayPath()): FakeOverlay {
  try {
    const parsed = OverlaySchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // A missing or unreadable overlay is not an error: the fake falls back to the pure seed.
  }
  return { version: 1, updatedAt: new Date().toISOString(), inventory: [] };
}

export function writeOverlay(overlay: FakeOverlay, path = overlayPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
}

export interface PersistentFakeOptions extends FakeShopifyAdminOptions {
  dataDir?: string;
}

/**
 * A `FakeShopifyAdmin` that loads the mutation overlay on construction and records inventory
 * writes back to it, so state survives across processes.
 */
export class PersistentFakeShopifyAdmin extends FakeShopifyAdmin {
  private readonly path: string;
  private overlay: FakeOverlay;

  constructor(options: PersistentFakeOptions = {}) {
    super(options);
    this.path = overlayPath(
      options.dataDir ?? process.env.DATA_DIR ?? ".molecule-data",
    );
    this.overlay = readOverlay(this.path);
    this.applyOverlay();
  }

  private applyOverlay(): void {
    for (const entry of this.overlay.inventory) {
      try {
        super.setInventory(entry.domain, entry.inventoryItemId, entry.quantity);
      } catch {
        // A stale overlay entry (renamed fixture, removed product) is dropped rather than
        // allowed to fail startup. The seed remains the source of truth.
      }
    }
  }

  override setInventory(
    domain: string,
    inventoryItemId: string,
    quantity: number,
  ): void {
    super.setInventory(domain, inventoryItemId, quantity);
    const normalized = normalizeDomain(domain);
    const existing = this.overlay.inventory.find(
      (entry) =>
        entry.domain === normalized &&
        entry.inventoryItemId === inventoryItemId,
    );
    if (existing) existing.quantity = quantity;
    else
      this.overlay.inventory.push({
        domain: normalized,
        inventoryItemId,
        quantity,
      });
    this.overlay.updatedAt = new Date().toISOString();
    writeOverlay(this.overlay, this.path);
  }

  override reset(): void {
    super.reset();
    this.overlay = {
      version: 1,
      updatedAt: new Date().toISOString(),
      inventory: [],
    };
    writeOverlay(this.overlay, this.path);
  }
}
