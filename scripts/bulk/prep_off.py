#!/usr/bin/env python3
"""Slim an Open Food Facts CSV dump (ODbL) into off_products.csv for bulk-load / catalog-fill.
Usage: python3 prep_off.py <in.csv(tsv)> <out.csv>
Prices do not exist in OFF: a deterministic synthetic CAD price is derived from the code (labelled synthetic downstream)."""
import csv, hashlib, sys
csv.field_size_limit(10**9)
src, dst = sys.argv[1], sys.argv[2]
KEEP = ["code", "product_name", "brands", "quantity", "pnns_groups_1", "pnns_groups_2", "main_category_en", "countries_en",
        "nutriscore_grade", "nova_group", "energy-kcal_100g", "sugars_100g", "fat_100g", "proteins_100g", "salt_100g",
        "allergens_en", "ingredients_text", "unique_scans_n"]
BAND = {"Beverages": (1.29, 6.99), "Sugary snacks": (1.49, 8.99), "Salty snacks": (1.99, 7.49), "Cereals and potatoes": (2.49, 9.99),
        "Milk and dairy products": (1.99, 11.99), "Fish Meat Eggs": (3.99, 19.99), "Fruits and vegetables": (1.49, 8.99),
        "Composite foods": (2.99, 12.99), "Fat and sauces": (1.99, 10.99)}
def price(code, group):
    lo, hi = BAND.get(group, (1.49, 12.99))
    h = int(hashlib.sha256(code.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return round(lo + (hi - lo) * h - 0.01, 2)
def num(x):
    try: return f"{float(x):.3f}"
    except: return ""
seen, n, kept = set(), 0, 0
with open(src, newline="", encoding="utf-8", errors="replace") as f, open(dst, "w", newline="") as o:
    r = csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE)
    h = next(r); ix = {k: i for i, k in enumerate(h)}
    w = csv.writer(o)
    w.writerow(KEEP + ["price_cad"])
    for row in r:
        n += 1
        if len(row) < len(h) - 5: continue
        g = lambda k: row[ix[k]].strip() if ix[k] < len(row) else ""
        code, name, brand, main = g("code"), g("product_name"), g("brands"), g("main_category_en")
        if not code or code in seen or not name or not brand or not main or len(name) > 120: continue
        seen.add(code)
        grp = g("pnns_groups_1")
        grp = "" if grp.lower() in ("unknown", "") else grp
        w.writerow([code, name, brand.split(",")[0].strip(), g("quantity"), grp, g("pnns_groups_2"), main, g("countries_en"),
                    g("nutriscore_grade"), num(g("nova_group")), num(g("energy-kcal_100g")), num(g("sugars_100g")), num(g("fat_100g")),
                    num(g("proteins_100g")), num(g("salt_100g")), g("allergens_en")[:200], g("ingredients_text")[:400], num(g("unique_scans_n")),
                    f"{price(code, grp):.2f}"])
        kept += 1
print("rows", n, "kept", kept)
