import { describe, expect, it } from "vitest";
import { autoLayoutFillFallback } from "../src/figma/sizing.js";

const verticalPhone = {
  layoutMode: "VERTICAL" as const,
  width: 393,
  height: 844,
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  itemSpacing: 0,
};

describe("autoLayoutFillFallback", () => {
  it("uses the remaining primary-axis height after fixed flow siblings", () => {
    expect(
      autoLayoutFillFallback("vertical", {
        ...verticalPhone,
        flowSiblings: [{ width: 393, height: 56 }],
      }),
    ).toBe(788);
  });

  it("uses the inner counter-axis width before laying out fixed-width text", () => {
    expect(
      autoLayoutFillFallback("horizontal", {
        ...verticalPhone,
        width: 393,
        paddingRight: 30,
        paddingLeft: 30,
        flowSiblings: [],
      }),
    ).toBe(333);
  });

  it("accounts for gaps between the current node and existing siblings", () => {
    expect(
      autoLayoutFillFallback("horizontal", {
        ...verticalPhone,
        layoutMode: "HORIZONTAL",
        itemSpacing: 12,
        flowSiblings: [
          { width: 80, height: 40 },
          { width: 40, height: 40 },
        ],
      }),
    ).toBe(249);
  });
});
