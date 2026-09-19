import { CatalogGallerySchema, type CatalogGallery } from "@molecule/contracts";
import { readCatalog, transaction } from "@molecule/db";
import { catalogCandidates } from "./catalog.js";

export async function catalogGallery(): Promise<CatalogGallery> {
  return transaction(async client => {
    const active = await client.query<{ catalog_version: string }>("select catalog_version from catalog_active_version");
    const version = active.rows[0]?.catalog_version;
    if (!version) return { catalogVersion: null, recipes: [] };
    const records = await readCatalog(version, client);
    const report = await catalogCandidates(client);
    const suppliers = await client.query<{ merchant_id: string; name: string }>("select merchant_id,name from merchants");
    const names = new Map(suppliers.rows.map(row => [row.merchant_id,row.name]));
    const verified = await client.query<{ recipe_id: string; ts: Date }>(`select payload->>'recipeId' as recipe_id,max(ts) as ts from molecule_events
      where event_type='catalog.recipe.verified' and payload->>'catalogVersion'=$1 and payload->>'mode'='mock' group by payload->>'recipeId'`, [version]);
    const verifications = new Map(verified.rows.map(row => [row.recipe_id,row.ts.toISOString()]));
    return CatalogGallerySchema.parse({ catalogVersion: version, recipes: records.filter(r => r.recordType === "recipe").map(recipe => {
      const products = new Set(recipe.intent.desiredOutputs.map(o => String(o.attributes.product ?? o.name)));
      const relevant = report.candidates.filter(c => c.capability.produces.some(port => products.has(String(port.attributes.product ?? port.name))));
      const relevantVariants = new Set(records.filter(r => r.recordType === "variant" && products.has(String(r.attributes.product))).map(r => r.id));
      const bindings = new Set(records.filter(r => r.recordType === "binding" && relevantVariants.has(r.variantId)).map(r => r.id));
      const missing = report.exclusions.filter(e => bindings.has(e.bindingId)).flatMap(e => e.reasons);
      for (const product of products) if (!relevant.some(c => c.capability.kind === "SUPPLY" && c.capability.produces.some(p => (p.attributes.product ?? p.name) === product))) missing.push(`No evidenced supply: ${product}`);
      return { id: recipe.id, category: recipe.category, prompt: recipe.prompt, outputKind: recipe.expected.outputKind, operations: recipe.expected.operations,
        connectedSuppliers: [...new Set(relevant.filter(c => c.selectedItem?.shopDomain).map(c => names.get(c.merchantId) ?? c.merchantId))],
        readiness: missing.length ? "missing_evidence" : verifications.has(recipe.id) ? "verified_mock" : "ready_for_solver",
        missingEvidence: [...new Set(missing)], synthetic: recipe.evidence.synthetic || relevant.some(c => c.synthetic), verifiedAt: verifications.get(recipe.id) ?? null };
    }) });
  });
}
