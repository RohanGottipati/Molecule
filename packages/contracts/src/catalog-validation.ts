import { CatalogManifestSchema, CatalogRecordSchema, type CatalogManifest, type CatalogRecord } from "./index.js";

export interface CatalogValidationReport {
  manifest?: CatalogManifest;
  records: CatalogRecord[];
  errors: string[];
  exclusions: { bindingId: string; reasons: string[] }[];
  coverage: { category: string; products: number; recipes: number; readyBindings: number }[];
}

/** Structural acceptance is separate from executable readiness and solver certification. */
export function validateCatalogJsonl(jsonl: string): CatalogValidationReport {
  const report: CatalogValidationReport = { records: [], errors: [], exclusions: [], coverage: [] };
  const lines = jsonl.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!report.manifest && report.records.length === 0 && index === 0)
        report.manifest = CatalogManifestSchema.parse(value);
      else report.records.push(CatalogRecordSchema.parse(value));
    } catch (error) {
      report.errors.push(`line ${index + 1}: ${error instanceof Error ? error.message : "Invalid JSON"}`);
    }
  }
  const manifest = report.manifest;
  if (!manifest) { report.errors.push("MISSING_MANIFEST"); return report; }
  const byId = new Map<string, CatalogRecord>();
  const stores = new Set<string>();
  const skus = new Set<string>();
  const inventoryMappings = new Set<string>();
  const variantMappings = new Set<string>();
  if (new Set(manifest.categories).size !== manifest.categories.length) report.errors.push("DUPLICATE_CATEGORY");
  for (const record of report.records) {
    if (byId.has(record.id)) report.errors.push(`DUPLICATE_ID ${record.id}`);
    byId.set(record.id, record);
    if (Date.parse(record.evidence.observedAt) > Date.parse(manifest.createdAt)) report.errors.push(`FUTURE_EVIDENCE ${record.id}`);
    if (record.recordType === "merchant" && record.shopDomain) {
      if (stores.has(record.shopDomain)) report.errors.push(`DUPLICATE_STORE ${record.shopDomain}`);
      stores.add(record.shopDomain);
    }
    if (record.recordType === "variant") {
      const key = `${record.merchantId}:${record.sku}`;
      if (skus.has(key)) report.errors.push(`DUPLICATE_SKU ${record.id}`);
      skus.add(key);
      if (record.shopify) {
        const mapping = `${record.merchantId}:${record.shopify.variantGid}`;
        if (variantMappings.has(mapping)) report.errors.push(`DUPLICATE_VARIANT_MAPPING ${record.id}`);
        variantMappings.add(mapping);
      }
    }
    if (record.recordType === "resource" && record.inventoryItemGid) {
      const key = `${record.merchantId}:${record.inventoryItemGid}:${record.locationGid}`;
      if (inventoryMappings.has(key)) report.errors.push(`DUPLICATE_RESOURCE_MAPPING ${record.id}`);
      inventoryMappings.add(key);
    }
    if ((record.recordType === "product" || record.recordType === "recipe") && !manifest.categories.includes(record.category))
      report.errors.push(`UNKNOWN_CATEGORY ${record.id}: ${record.category}`);
  }
  for (const [kind, count] of Object.entries(manifest.recordCounts)) {
    if (report.records.filter(record => record.recordType === kind).length !== count)
      report.errors.push(`COUNT_MISMATCH ${kind}: expected ${count}`);
  }
  function reference(record: CatalogRecord, field: string, id: string, kind?: CatalogRecord["recordType"]) {
    const target = byId.get(id);
    if (!target || (kind && target.recordType !== kind)) {
      report.errors.push(`UNKNOWN_REFERENCE ${record.id}.${field}: ${id}`);
      return undefined;
    }
    if ("merchantId" in record && "merchantId" in target && target.merchantId !== record.merchantId)
      report.errors.push(`CROSS_MERCHANT_REFERENCE ${record.id}.${field}`);
    return target;
  }
  for (const record of report.records) {
    if ("merchantId" in record) reference(record, "merchantId", record.merchantId, "merchant");
    if (record.recordType === "variant") {
      reference(record, "productId", record.productId, "product");
      if (record.material.status === "known" && (typeof record.material.value !== "string" || !record.material.value.trim()))
        report.errors.push(`INVALID_MATERIAL ${record.id}`);
    }
    if (record.recordType === "fact") reference(record, "subjectId", record.subjectId, "binding");
    if (record.recordType !== "binding") continue;
    const reasons: string[] = [];
    const family = reference(record, "familyId", record.familyId, "family");
    const variant = reference(record, "variantId", record.variantId, "variant");
    if (variant?.recordType === "variant") {
      if (variant.material.status !== "known") reasons.push(`material:${variant.material.status}`);
      if (family?.recordType === "family" && !variant.supportedOperations.includes(family.operation))
        reasons.push(`unsupported_operation:${family.operation}`);
    }
    for (const [field, id] of Object.entries(record.factIds)) {
      const fact = reference(record, `factIds.${field}`, id, "fact");
      if (fact?.recordType !== "fact") continue;
      if (fact.subjectId !== record.id || fact.field !== field) report.errors.push(`FACT_SCOPE_MISMATCH ${record.id}.${field}`);
      if (fact.assertion.status !== "known") reasons.push(`${field}:${fact.assertion.status}`);
    }
    if (new Set(record.resources.map(r => r.resourceId)).size !== record.resources.length)
      report.errors.push(`DUPLICATE_RESOURCE ${record.id}`);
    for (const ref of record.resources) {
      const resource = reference(record, "resources", ref.resourceId, "resource");
      if (resource?.recordType === "resource") {
        if (resource.availability.status !== "known") reasons.push(`${resource.id}:${resource.availability.status}`);
        else if (resource.availability.value === 0) reasons.push(`${resource.id}:unavailable`);
        if (variant?.recordType === "variant" && resource.unit !== variant.unit) reasons.push(`${resource.id}:unit_mismatch`);
      }
    }
    report.exclusions.push({ bindingId: record.id, reasons });
  }
  report.coverage = manifest.categories.map(category => {
    const products = report.records.filter(r => r.recordType === "product" && r.category === category);
    const ids = new Set(products.map(p => p.id));
    const variants = new Set(report.records.filter(r => r.recordType === "variant" && ids.has(r.productId)).map(r => r.id));
    const ready = new Set(report.exclusions.filter(e => !e.reasons.length).map(e => e.bindingId));
    return { category, products: products.length,
      recipes: report.records.filter(r => r.recordType === "recipe" && r.category === category).length,
      readyBindings: report.records.filter(r => r.recordType === "binding" && variants.has(r.variantId) && ready.has(r.id)).length };
  });
  return report;
}
