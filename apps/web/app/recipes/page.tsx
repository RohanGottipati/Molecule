"use client";

import { CatalogGallerySchema, type CatalogGallery } from "@molecule/contracts";
import { useEffect, useState } from "react";
import { request } from "../../lib/api";

const labels = { missing_evidence: "Missing evidence", ready_for_solver: "Ready for solver", verified_mock: "Verified with mocks", verified_live: "Verified live" };
export default function RecipesPage() {
  const [gallery, setGallery] = useState<CatalogGallery>();
  const [category, setCategory] = useState("All categories");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request("/api/catalog/recipes", { signal: controller.signal }).then(value => setGallery(CatalogGallerySchema.parse(value))).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Catalog unavailable");
    });
    return () => controller.abort();
  }, []);
  return <main style={{ maxWidth: 1120, margin: "0 auto", padding: "40px 24px" }}>
    <a href="/">← Workspace</a>
    <h1>Recipe gallery</h1>
    <p>Explore individual products and bundles, their required operations, and the evidence available for planning.</p>
    {error && <p role="alert">{error}</p>}
    {!gallery && !error && <p role="status">Loading catalog…</p>}
    {gallery && <>
      <p>{gallery.recipes.length} recipes · Catalog {gallery.catalogVersion ?? "not activated"}</p>
      <label>Category <select value={category} onChange={event => setCategory(event.target.value)}>
        {["All categories", ...new Set(gallery.recipes.map(recipe => recipe.category))].map(value => <option key={value}>{value}</option>)}
      </select></label>
      {!gallery.recipes.length && <p>No validated catalog has been activated. Imported products become recipes only after their requirements and evidence are supplied.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 20, marginTop: 24 }}>
        {gallery.recipes.filter(recipe => category === "All categories" || recipe.category === category).map(recipe => <article key={recipe.id} style={{ border: "1px solid #bac9c5", borderRadius: 12, padding: 20 }}>
          <small>{recipe.category} · {recipe.outputKind === "individual" ? "Individual product" : "Bundle"}</small>
          <h2 style={{ fontSize: 20 }}>{recipe.id.replace(/^recipe:/, "").replaceAll("-", " ")}</h2>
          <p>{recipe.prompt}</p>
          <p><strong>{labels[recipe.readiness]}</strong>{recipe.synthetic ? " · Synthetic operating facts" : ""}</p>
          <p>Operations: {recipe.operations.map(op => op.replaceAll("_", " ")).join(", ")}</p>
          <p>Connected suppliers: {recipe.connectedSuppliers.join(", ") || "No connected store mappings"}</p>
          {recipe.missingEvidence.length > 0 && <details><summary>Missing evidence ({recipe.missingEvidence.length})</summary><ul>{recipe.missingEvidence.map(reason => <li key={reason}>{reason}</li>)}</ul></details>}
          <p>Latest verification: {recipe.verifiedAt ? new Date(recipe.verifiedAt).toLocaleString() : "Not verified"}</p>
        </article>)}
      </div>
    </>}
  </main>;
}
