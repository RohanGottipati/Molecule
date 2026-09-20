import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductionPlanSchema } from "@molecule/contracts";
import { activateCatalog, importCatalog } from "./catalog.js";
import { reserveCatalogPlan, releaseCatalogPlan } from "./catalogReservations.js";
import { closePool, getPool } from "./client.js";
import { migrate } from "./migrations.js";

const database = process.env.TEST_DATABASE_URL;
const id = `reservation-${randomUUID()}`;
const observedAt = "2026-09-19T00:00:00Z";
function plan(order: string, kind: "inventory" | "processing") {
  return ProductionPlanSchema.parse({ planId: `${id}:${order}`, orderId: order, intentVersion: 1, status: "VALID", edges: [], totalCost: 2, currency: "CAD", riskScore: 0, constraintResults: [],
    nodes: [{ nodeId: "node", merchantId: id, capabilityId: `bound:${id}:b:${kind}`, kind: "SUPPLY", quantity: 2, unitCost: 1, totalCost: 2,
      catalogVersion: id, selectedItem: { bindingId: `b:${kind}`, productId: "p", variantId: "v", sku: "S", itemKind: "physical" },
      startsAt: "2026-09-19T12:00:00Z", completesAt: "2026-09-19T13:00:00Z",
      resourceRefs: [{ resourceId: `${id}:${kind}`, kind, unit: "units", unitsPerItem: 1, available: kind === "inventory" ? 3 : 2, ...(kind === "processing" ? { periodMinutes: 60 } : {}), observedAt, sourceReference: "fixture:reservation" }] }] });
}
describe.skipIf(!database)("transactional shared inventory and scheduled machine reservations", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = database;
    await migrate();
    const evidence = { observedAt, sourceReference: "fixture:reservation", synthetic: true };
    const records = [
      { recordType: "merchant", id, name: "Reservation merchant", evidence },
      { recordType: "product", id: "p", merchantId: id, name: "Blank", category: "Apparel", itemKind: "physical", evidence },
      { recordType: "variant", id: "v", merchantId: id, productId: "p", sku: "S", material: { status: "known", value: "cotton" }, attributes: {}, supportedOperations: ["supply"], unit: "units", evidence },
      { recordType: "family", id: "f", kind: "SUPPLY", operation: "supply", accepts: [], produces: [{ kind: "product", name: "Blank", unit: "units", attributes: {} }], requiredAssetIds: [], evidence },
      ...["inventory", "processing"].flatMap(kind => {
        const binding = `b:${kind}`;
        const facts = { pricing: { currency: "CAD", basis: "per_item", unitPrice: 1, setupFee: 0, minimumTotal: 0 }, quantity: { min: 1, max: 100, unit: "units" }, timing: { leadMinutes: 60, transferMinutes: 0 }, coverage: { countries: ["CA"] } };
        return [
          { recordType: "resource", id: `${id}:${kind}`, merchantId: id, kind, unit: "units", availability: { status: "known", value: kind === "inventory" ? 3 : 2 }, ...(kind === "processing" ? { periodMinutes: 60 } : {}), evidence },
          { recordType: "binding", id: binding, merchantId: id, familyId: "f", variantId: "v", resources: [{ resourceId: `${id}:${kind}`, unitsPerItem: 1 }], factIds: Object.fromEntries(Object.keys(facts).map(field => [field, `${binding}:${field}`])), evidence },
          ...Object.entries(facts).map(([field, value]) => ({ recordType: "fact", id: `${binding}:${field}`, merchantId: id, subjectId: binding, field, assertion: { status: "known", value }, evidence })),
        ];
      }),
    ];
    const recordCounts = Object.fromEntries(["merchant", "resource", "product", "variant", "binding", "fact", "family", "recipe"].map(kind => [kind, records.filter(r => r.recordType === kind).length]));
    await importCatalog([{ recordType: "manifest", schemaVersion: 1, catalogVersion: id, complete: true, createdAt: observedAt, categories: ["Apparel"], recordCounts }, ...records].map(r => JSON.stringify(r)).join("\n"), id);
    await activateCatalog(id, id, id);
  });
  afterAll(async () => { await getPool().query("delete from catalog_active_version where catalog_version=$1", [id]); await closePool(); });
  it("rejects fabricated SKU selections and reduced resource consumption", async () => {
    const forged = plan("forged", "inventory");
    forged.nodes[0]!.selectedItem!.sku = "OTHER";
    await expect(reserveCatalogPlan(forged,id,`${id}:forged`)).rejects.toThrow("INVALID_CATALOG_SELECTION");
    const reduced = plan("reduced", "inventory");
    reduced.nodes[0]!.resourceRefs![0]!.unitsPerItem = 0.1;
    await expect(reserveCatalogPlan(reduced,id,`${id}:reduced`)).rejects.toThrow("INVALID_RESOURCE_REFERENCES");
  });
  it("allows exactly one concurrent stock commit and preserves idempotent retries", async () => {
    const a = plan("a", "inventory"), b = plan("b", "inventory");
    const results = await Promise.allSettled([reserveCatalogPlan(a,id,`${id}:a`),reserveCatalogPlan(b,id,`${id}:b`)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? a : b;
    const key = `${id}:${winner.orderId}`;
    expect(await reserveCatalogPlan(winner,id,key)).toHaveLength(1);
    await expect(reserveCatalogPlan({ ...winner, planId: "changed" },id,key)).rejects.toThrow("ACTION_KEY_CONFLICT");
    await releaseCatalogPlan(winner.planId,id,`${key}:release`);
  });
  it("rejects overlapping machine intervals but admits an adjacent interval", async () => {
    const a = plan("machine-a", "processing"), b = plan("machine-b", "processing");
    await reserveCatalogPlan(a,id,`${id}:machine-a`);
    await expect(reserveCatalogPlan(b,id,`${id}:machine-b`)).rejects.toThrow("PROCESSING_INTERVAL_RESERVED");
    b.nodes[0]!.startsAt = "2026-09-19T13:00:00Z";
    b.nodes[0]!.completesAt = "2026-09-19T14:00:00Z";
    await reserveCatalogPlan(b,id,`${id}:machine-b`);
    await releaseCatalogPlan(a.planId,id,`${id}:release-machine-a`);
    await releaseCatalogPlan(b.planId,id,`${id}:release-machine-b`);
  });
});
