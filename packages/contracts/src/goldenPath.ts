/**
 * The golden path is one canonical brief whose interpretation is fixed rather
 * than modelled, so a demonstration run is fully deterministic end to end.
 * Only the brief text lives here; the hardcoded intent is owned by the
 * compiler adapter and the expected plan by the orchestrator.
 */
export const GOLDEN_PATH_PROMPT =
  "Make 200 premium black onboarding kits by next Friday under CAD 7,000. No leather. Each kit needs a hoodie with logo embroidery, a named engraved bottle, vegan snacks and individual packaging.";

export const GOLDEN_PATH_CORRECTION = "No polyester.";

const GOLDEN_PATH_PROMPT_ALIASES = [
  GOLDEN_PATH_PROMPT,
  "200 premium black onboarding kits by next Friday under CAD 7000, no leather, hoodie logo embroidery, named engraved bottles, vegan snacks and individual packaging.",
];

export function normalizeBriefText(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function isGoldenPathPrompt(text: string): boolean {
  const normalized = normalizeBriefText(text);
  return GOLDEN_PATH_PROMPT_ALIASES.some(
    (alias) => normalizeBriefText(alias) === normalized,
  );
}

export function isGoldenPathCorrection(text: string): boolean {
  return normalizeBriefText(text) === normalizeBriefText(GOLDEN_PATH_CORRECTION);
}
