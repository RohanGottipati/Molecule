// Number parsing shared by normalization and evaluation. Kept free of database
// and provider imports so pure modules (and tests) can use it.

const WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  hundred: 100,
  thousand: 1000,
};

/**
 * Parses a number the way a document writes it. Returns null for anything it
 * cannot read with certainty - including OCR damage like "4l.8O", which looks
 * numeric but is not.
 */
export function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // Words: "four hundred", "a thousand", "zero".
  const words = s
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (
    words.length &&
    words.every((w) => w in WORDS || w === "a" || w === "and")
  ) {
    let total = 0,
      current = 0;
    for (const w of words) {
      if (w === "a") {
        current = current || 1;
        continue;
      }
      if (w === "and") continue;
      const v = WORDS[w];
      if (v === 100 || v === 1000) current = (current || 1) * v;
      else current += v;
    }
    total += current;
    return Number.isFinite(total) ? total : null;
  }

  s = s
    .replace(/[$€£]/g, "")
    .replace(/\b(cad|usd|gbp|eur)\b/g, "")
    .trim();
  s = s.replace(
    /^(about|approx\.?|approximately|around|under|over|up to|~)\s*/i,
    "",
  );
  s = s.replace(/,(?=\d{3}\b)/g, ""); // thousands separators
  s = s.replace(/(\d),(\d)/g, "$1.$2"); // European decimal comma
  s = s
    .replace(
      /\s*(units?|pcs?|pieces?|ea|each|kits?|hoodies|bottles|packs?)\b.*$/i,
      "",
    )
    .trim();
  s = s
    .replace(/\s*(\/|per\s+)?(day|week|month|hour|hours|h)\b.*$/i, "")
    .trim();

  // Anything left that is not a plain number is not a number we will accept.
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
