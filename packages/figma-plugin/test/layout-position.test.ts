import { describe, expect, it } from "vitest";
import {
  fromFigmaLayoutPositioning,
  toFigmaLayoutPositioning,
} from "../src/figma/layout-position.js";

describe("Figma auto-layout child positioning", () => {
  it("writes Pencil absolute children using Figma's layoutPositioning API", () => {
    expect(toFigmaLayoutPositioning("absolute")).toBe("ABSOLUTE");
    expect(toFigmaLayoutPositioning("auto")).toBe("AUTO");
  });

  it("reads Figma absolute children back into Pencil semantics", () => {
    expect(fromFigmaLayoutPositioning("ABSOLUTE")).toBe("absolute");
    expect(fromFigmaLayoutPositioning("AUTO")).toBe("auto");
  });
});
