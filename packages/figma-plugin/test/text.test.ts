import { describe, expect, it } from "vitest";
import { longestTextSegment } from "../src/figma/text.js";

describe("longestTextSegment", () => {
  it("selects the range covering the most text", () => {
    const dominant = { start: 2, end: 14, style: "body" };
    expect(
      longestTextSegment([
        { start: 0, end: 2, style: "lead" },
        dominant,
        { start: 14, end: 18, style: "tail" },
      ]),
    ).toBe(dominant);
  });

  it("keeps the first range when lengths are tied", () => {
    const first = { start: 0, end: 4, style: "first" };
    expect(
      longestTextSegment([first, { start: 4, end: 8, style: "second" }]),
    ).toBe(first);
  });

  it("returns undefined for an empty text layer", () => {
    expect(longestTextSegment([])).toBeUndefined();
  });
});
