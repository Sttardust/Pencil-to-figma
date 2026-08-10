import { describe, expect, it } from "vitest";
import { findCleanRightSidePosition } from "../src/figma/placement.js";

describe("findCleanRightSidePosition", () => {
  it("centers the first imported root in an empty page", () => {
    expect(
      findCleanRightSidePosition(400, 800, [], { x: 500, y: 500 }),
    ).toEqual({ x: 300, y: 100 });
  });

  it("places later imports beyond every occupied top-level node", () => {
    expect(
      findCleanRightSidePosition(
        400,
        800,
        [
          { x: 0, y: 0, width: 400, height: 800 },
          { x: 600, y: -200, width: 500, height: 1200 },
        ],
        { x: 500, y: 500 },
      ),
    ).toEqual({ x: 1220, y: 100 });
  });

  it("keeps every screen in a batch on the same top edge", () => {
    const first = findCleanRightSidePosition(393, 844, [], { x: 500, y: 500 });
    const second = findCleanRightSidePosition(
      393,
      932,
      [{ x: first.x, y: first.y, width: 393, height: 844 }],
      { x: 500, y: 500 },
      120,
      first.y,
    );

    expect(second).toEqual({ x: 816.5, y: first.y });
  });
});
