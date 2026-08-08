import { describe, expect, it } from "vitest";
import { directFontCandidates, rankFontFallbacks } from "../src/figma/fonts.js";

describe("rankFontFallbacks", () => {
  const available = [
    { family: "Inter", style: "Regular" },
    { family: "Inter", style: "Medium" },
    { family: "Georgia", style: "Regular" },
    { family: "Georgia", style: "Bold" },
  ];

  it("uses a serif-compatible weight for unavailable Fraunces styles", () => {
    expect(
      rankFontFallbacks({ family: "Fraunces", style: "Medium" }, available)[0],
    ).toEqual({ family: "Georgia", style: "Regular" });
    expect(
      rankFontFallbacks(
        { family: "Fraunces", style: "Semi Bold" },
        available,
      )[0],
    ).toEqual({ family: "Georgia", style: "Bold" });
  });

  it("keeps an exact available font first", () => {
    expect(
      rankFontFallbacks({ family: "Inter", style: "Medium" }, available)[0],
    ).toEqual({ family: "Inter", style: "Medium" });
  });

  it("builds a bounded direct fallback list without enumerating Figma fonts", () => {
    const candidates = directFontCandidates({
      family: "Fraunces",
      style: "Semi Bold",
    });
    expect(candidates[0]).toEqual({
      family: "Fraunces",
      style: "Semi Bold",
    });
    expect(candidates[1]).toEqual({ family: "Georgia", style: "Bold" });
    expect(candidates.length).toBeLessThanOrEqual(6);
  });
});
