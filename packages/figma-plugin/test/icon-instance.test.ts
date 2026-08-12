import { describe, expect, it } from "vitest";
import { isIconInstanceCandidate } from "../src/figma/read.js";

describe("Figma icon instance detection", () => {
  it("rasterizes small vector-only instances", () => {
    expect(
      isIconInstanceCandidate({
        width: 24,
        height: 24,
        hasText: false,
        hasImage: false,
        hasVectorGeometry: true,
      }),
    ).toBe(true);
  });

  it("keeps buttons, photos, and large illustrations as components", () => {
    expect(
      isIconInstanceCandidate({
        width: 24,
        height: 24,
        hasText: true,
        hasImage: false,
        hasVectorGeometry: true,
      }),
    ).toBe(false);
    expect(
      isIconInstanceCandidate({
        width: 40,
        height: 40,
        hasText: false,
        hasImage: true,
        hasVectorGeometry: true,
      }),
    ).toBe(false);
    expect(
      isIconInstanceCandidate({
        width: 120,
        height: 120,
        hasText: false,
        hasImage: false,
        hasVectorGeometry: true,
      }),
    ).toBe(false);
  });
});
