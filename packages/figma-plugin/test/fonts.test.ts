import { importPenDocument } from "@pen-fig/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { directFontCandidates, rankFontFallbacks } from "../src/figma/fonts.js";
import { preflightFonts } from "../src/figma/write.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("preflightFonts", () => {
  it("loads Figma's default Inter Regular before mutating a new text node", async () => {
    const loadFontAsync = vi.fn(async () => undefined);
    vi.stubGlobal("figma", { loadFontAsync });
    const document = importPenDocument(
      {
        id: "screen",
        type: "frame",
        width: 393,
        height: 844,
        children: [
          {
            id: "label",
            type: "text",
            content: "Profile",
            fontFamily: "Stack Sans Text",
            fontSize: 16,
          },
        ],
      },
      { documentId: "test.pen" },
    );

    await preflightFonts(document);

    expect(loadFontAsync).toHaveBeenCalledWith({
      family: "Inter",
      style: "Regular",
    });
    expect(loadFontAsync).toHaveBeenCalledWith({
      family: "Stack Sans Text",
      style: "Regular",
    });
  });
});
