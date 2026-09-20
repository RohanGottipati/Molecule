"use client";

import { CatalogGallerySchema, type CatalogGallery } from "@molecule/contracts";
import { useEffect, useState } from "react";
import { sidebarDestinations } from "../../components/Sidebar";
import { SidebarIcon } from "../../components/SidebarIcons";
import { projectHref } from "../../lib/navigation";
import { request } from "../../lib/api";

const labels = {
  missing_evidence: "Customize your brief",
  ready_for_solver: "Ready to plan",
  verified_mock: "Validation checked",
  verified_live: "Verified live",
};
export default function RecipesPage() {
  const [gallery, setGallery] = useState<CatalogGallery>();
  const [category, setCategory] = useState("All categories");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
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
              <p>A starting point for your next creation.</p>
            </div>
          </header>
          {error && <p role="alert">{error}</p>}
          {!gallery && !error && <p role="status">Loading catalog…</p>}
          {gallery && (
            <>
              <div className="recipe-toolbar">
                <p>
                  {gallery.recipes.length} recipes ·{" "}
                  {gallery.recipes.some((r) => r.synthetic)
                    ? "Curated collection"
                    : "Production collection"}
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
              </div>
              <p className="sr-only" role="status">
                {copied ? "Brief copied. Paste it into a new project." : ""}
              </p>
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
                      <h2>
                        {recipe.id.replace(/^recipe:/, "").replaceAll("-", " ")}
                      </h2>
                      <p>{recipe.prompt}</p>
                      <span className="recipe-readiness">
                        {labels[recipe.readiness]}
                      </span>
                      <div className="recipe-operations">
                        {recipe.operations.map((op) => (
                          <span key={op}>{op.replaceAll("_", " ")}</span>
                        ))}
                      </div>
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
                      <div className="recipe-card-footer">
                        <span className="muted small">
                          {recipe.synthetic ? "Recipe" : "Catalog recipe"}
                        </span>
                        <button
                          type="button"
                          className="secondary"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                recipe.prompt,
                              );
                              setCopied(recipe.id);
                            } catch {
                              setError(
                                "Could not copy the brief. Select the recipe text to copy it.",
                              );
                            }
                          }}
                        >
                          {copied === recipe.id ? "Copied ✓" : "Copy brief ↗"}
                        </button>
                      </div>
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
