import type { CanonicalClaim, MerchantCapability } from "@molecule/contracts";

/**
 * Read-only seam onto Reality/Tiger canonical truth (T4/T5/T6 in the
 * playbook: services/reality, canonical_claims, capability search). That
 * service and packages/db do not exist yet, so tool handlers depend on this
 * interface rather than a concrete store; a Postgres/Reality-backed
 * implementation can be swapped in later without changing any tool.
 *
 * Never treat RAG/document text as this data. get_inventory/get_capacity/
 * get_canonical_claims are the only source of truth merchant-agent tools may
 * use for live facts (B2/B3: "Never use RAG output as canonical inventory/
 * capacity without cross-checking tools/Reality service").
 */
export interface CanonicalDataClient {
  getInventory(
    merchantId: string,
    sku: string,
  ): Promise<InventorySnapshot | undefined>;
  getCapability(
    merchantId: string,
    capabilityId: string,
  ): Promise<MerchantCapability | undefined>;
  getCanonicalClaims(
    merchantId: string,
    fields: string[],
  ): Promise<CanonicalClaim[]>;
}

export interface InventorySnapshot {
  merchantId: string;
  sku: string;
  available: number;
  asOf: string;
}

/**
 * Deterministic in-memory stand-in seeded with a slice of the playbook's
 * demo seed world (section 15) so tools are runnable/testable before Reality
 * lands. Swap for a Reality-backed client without touching tool definitions.
 */
export class InMemoryCanonicalDataClient implements CanonicalDataClient {
  private readonly inventory = new Map<string, InventorySnapshot>();
  private readonly capabilities = new Map<string, MerchantCapability>();
  private readonly claims = new Map<string, CanonicalClaim[]>();

  private inventoryKey(merchantId: string, sku: string): string {
    return `${merchantId}::${sku}`;
  }

  seedInventory(snapshot: InventorySnapshot): void {
    this.inventory.set(
      this.inventoryKey(snapshot.merchantId, snapshot.sku),
      snapshot,
    );
  }

  seedCapability(capability: MerchantCapability): void {
    this.capabilities.set(
      `${capability.merchantId}::${capability.capabilityId}`,
      capability,
    );
  }

  seedClaims(merchantId: string, claims: CanonicalClaim[]): void {
    this.claims.set(merchantId, claims);
  }

  async getInventory(
    merchantId: string,
    sku: string,
  ): Promise<InventorySnapshot | undefined> {
    return this.inventory.get(this.inventoryKey(merchantId, sku));
  }

  async getCapability(
    merchantId: string,
    capabilityId: string,
  ): Promise<MerchantCapability | undefined> {
    return this.capabilities.get(`${merchantId}::${capabilityId}`);
  }

  async getCanonicalClaims(
    merchantId: string,
    fields: string[],
  ): Promise<CanonicalClaim[]> {
    const merchantClaims = this.claims.get(merchantId) ?? [];
    if (fields.length === 0) {
      return [...merchantClaims];
    }
    return merchantClaims.filter((claim) => fields.includes(claim.field));
  }
}
