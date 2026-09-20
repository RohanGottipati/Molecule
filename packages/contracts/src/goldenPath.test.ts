import { describe, expect, it } from "vitest";
import {
  GOLDEN_PATH_CORRECTION,
  GOLDEN_PATH_PROMPT,
  isGoldenPathCorrection,
  isGoldenPathPrompt,
} from "./goldenPath.js";

describe("golden path prompt", () => {
  it("matches the canonical brief regardless of casing, spacing and number punctuation", () => {
    expect(isGoldenPathPrompt(GOLDEN_PATH_PROMPT)).toBe(true);
    expect(
      isGoldenPathPrompt(
        `  ${GOLDEN_PATH_PROMPT.toUpperCase().replace("7,000", "7000")}\n`,
      ),
    ).toBe(true);
    expect(
      isGoldenPathPrompt(
        "200 premium black onboarding kits by next Friday under CAD 7000, no leather, hoodie logo embroidery, named engraved bottles, vegan snacks and individual packaging.",
      ),
    ).toBe(true);
  });

  it("does not match briefs that change any requirement", () => {
    expect(isGoldenPathPrompt(GOLDEN_PATH_PROMPT.replace("200", "250"))).toBe(
      false,
    );
    expect(isGoldenPathPrompt(GOLDEN_PATH_PROMPT.replace("CAD", "USD"))).toBe(
      false,
    );
    expect(isGoldenPathPrompt(`${GOLDEN_PATH_PROMPT} Also add mugs.`)).toBe(
      false,
    );
    expect(isGoldenPathPrompt("Make 200 hoodies")).toBe(false);
  });

  it("recognises only the canonical correction", () => {
    expect(isGoldenPathCorrection(GOLDEN_PATH_CORRECTION)).toBe(true);
    expect(isGoldenPathCorrection("no polyester")).toBe(true);
    expect(isGoldenPathCorrection("No polyester or leather")).toBe(false);
  });
});
