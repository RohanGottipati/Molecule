// Quantity parsing: the unit tables, the rule compiler and the rule runner.
//
// Separate from rules.mjs so these can be imported, tested and reused without
// running the mining pipeline as a side effect.

// Canonical units. The model proposes patterns; it does not get to invent physics.
const TO_GRAMS = {
  g: 1,
  gram: 1,
  grams: 1,
  gr: 1,
  kg: 1000,
  mg: 0.001,
  oz: 28.3495,
  ozs: 28.3495,
  lb: 453.592,
  lbs: 453.592,
  pound: 453.592,
  pounds: 453.592,
};
const TO_ML = {
  ml: 1,
  millilitre: 1,
  milliliter: 1,
  cl: 10,
  dl: 100,
  l: 1000,
  litre: 1000,
  liter: 1000,
  "fl oz": 29.5735,
  floz: 29.5735,
  qt: 946.353,
  quart: 946.353,
  gallon: 3785.41,
  gal: 3785.41,
  pint: 473.176,
};

export function canonicalise(value, unit, count = 1) {
  const u = String(unit ?? "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  const n = Number(value) * (Number(count) || 1);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (u in TO_GRAMS)
    return {
      grams: Math.round(n * TO_GRAMS[u] * 1000) / 1000,
      millilitres: null,
    };
  if (u in TO_ML)
    return { grams: null, millilitres: Math.round(n * TO_ML[u] * 1000) / 1000 };
  return null;
}

/** Compiles a proposed rule, refusing anything that will not run safely. */
export function compileRule(rule) {
  try {
    const re = new RegExp(
      rule.pattern,
      rule.flags?.includes("g")
        ? rule.flags.replace("g", "")
        : rule.flags || "i",
    );
    // A pattern that takes too long on a short string is rejected outright.
    const started = Date.now();
    re.test("10x 0.8 oz (22.7 g) - Net weight 8 oz (227 g)".repeat(2));
    if (Date.now() - started > 50) return null;
    return { ...rule, re };
  } catch {
    return null;
  }
}

export function applyRules(label, rules) {
  const text = String(label ?? "").slice(0, 160);
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const rawValue = (m[rule.valueGroup] ?? "").replace(",", ".");
    const count = rule.countGroup
      ? Number((m[rule.countGroup] ?? "1").replace(",", "."))
      : 1;
    const unit = rule.unitGroup ? m[rule.unitGroup] : rule.unitLiteral;
    if (String(unit ?? "").toLowerCase() === "count") {
      const n = Number(rawValue) * (Number(count) || 1);
      if (!Number.isFinite(n) || n <= 0) continue;
      return {
        grams: null,
        millilitres: null,
        count_units: n,
        rule_id: rule.rule_id,
        name: rule.name,
      };
    }
    const canon = canonicalise(rawValue, unit, count);
    if (canon)
      return {
        ...canon,
        count_units: null,
        rule_id: rule.rule_id,
        name: rule.name,
      };
  }
  return null;
}

export const agree = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return (
    Math.abs(Number(a) - Number(b)) <= Math.max(0.5, Math.abs(Number(b)) * 0.02)
  );
};
