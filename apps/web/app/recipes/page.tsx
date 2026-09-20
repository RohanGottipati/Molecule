"use client";

import { CatalogGallerySchema, type CatalogGallery } from "@molecule/contracts";
import { useEffect, useState } from "react";
import { sidebarDestinations } from "../../components/Sidebar";
import { SidebarIcon } from "../../components/SidebarIcons";
import { projectHref } from "../../lib/navigation";
import { request } from "../../lib/api";

const labels = {
  missing_evidence: "Missing evidence",
  ready_for_solver: "Ready for solver",
  verified_mock: "Verified with mocks",
  verified_live: "Verified live",
};
export default function RecipesPage() {
  const [gallery, setGallery] = useState<CatalogGallery>();
  const [category, setCategory] = useState("All categories");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request("/api/catalog/recipes", { signal: controller.signal })
      .then((value) => setGallery(CatalogGallerySchema.parse(value)))
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "Catalog unavailable",
          );
      });
    return () => controller.abort();
  }, []);
  return (
    <div className="dashboard-shell app-shell">
      <aside className="sidebar">
        <nav aria-label="Main navigation">
          <a className="nav-item" href="/">
            <SidebarIcon name="home" />
            Home
          </a>
          {sidebarDestinations.map((item) => (
            <a
              key={item.key}
              className="nav-item"
              href={projectHref(null, item.key)}
            >
              <SidebarIcon name={item.icon} />
              {item.label}
            </a>
          ))}
          <a className="nav-item active" href="/recipes" aria-current="page">
            <SidebarIcon name="recipes" />
            Recipe gallery
          </a>
        </nav>
      </aside>
      <main className="main-shell">
        <div className="main-content recipe-page">
          <header className="page-heading">
            <div>
              <h1>Recipe gallery</h1>
              <p>Products, bundles and the evidence needed to plan them.</p>
            </div>
          </header>
          {error && <p role="alert">{error}</p>}
          {!gallery && !error && <p role="status">Loading catalog…</p>}
          {gallery && (
            <>
              <p>
                {gallery.recipes.length} recipes · Catalog{" "}
                {gallery.catalogVersion ?? "not activated"}
              </p>
              <label>
                Category{" "}
                <select
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                >
                  {[
                    "All categories",
                    ...new Set(
                      gallery.recipes.map((recipe) => recipe.category),
                    ),
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              {!gallery.recipes.length && (
                <section className="panel empty-state recipe-empty">
                  <h2>No recipes available yet</h2>
                  <p>Recipes appear when a validated catalog is activated.</p>
                  <a className="secondary" href="/?view=merchants">
                    Explore suppliers
                  </a>
                </section>
              )}
              <div className="recipe-grid">
                {gallery.recipes
                  .filter(
                    (recipe) =>
                      category === "All categories" ||
                      recipe.category === category,
                  )
                  .map((recipe) => (
                    <article key={recipe.id} className="recipe-card">
                      <small>
                        {recipe.category} ·{" "}
                        {recipe.outputKind === "individual"
                          ? "Individual product"
                          : "Bundle"}
                      </small>
                      <h2 style={{ fontSize: 20 }}>
                        {recipe.id.replace(/^recipe:/, "").replaceAll("-", " ")}
                      </h2>
                      <p>{recipe.prompt}</p>
                      <p>
                        <strong>{labels[recipe.readiness]}</strong>
                        {recipe.synthetic ? " · Synthetic operating facts" : ""}
                      </p>
                      <p>
                        Operations:{" "}
                        {recipe.operations
                          .map((op) => op.replaceAll("_", " "))
                          .join(", ")}
                      </p>
                      <p>
                        Connected suppliers:{" "}
                        {recipe.connectedSuppliers.join(", ") ||
                          "No connected store mappings"}
                      </p>
                      {recipe.missingEvidence.length > 0 && (
                        <details>
                          <summary>
                            Missing evidence ({recipe.missingEvidence.length})
                          </summary>
                          <ul>
                            {recipe.missingEvidence.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      <p>
                        Latest verification:{" "}
                        {recipe.verifiedAt
                          ? new Date(recipe.verifiedAt).toLocaleString()
                          : "Not verified"}
                      </p>
                    </article>
                  ))}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
