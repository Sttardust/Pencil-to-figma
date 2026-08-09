import type { BridgeDocument, BridgeNode } from "@pen-fig/bridge-schema";
import { describe, expect, it } from "vitest";
import {
  normalizeGeometryForFigma,
  uniformValue,
} from "../src/figma/geometry.js";

function node(
  overrides: Partial<BridgeNode> & Pick<BridgeNode, "bridgeId" | "kind">,
): BridgeNode {
  return {
    bridgeId: overrides.bridgeId,
    kind: overrides.kind,
    name: overrides.name ?? overrides.bridgeId,
    source: { app: "pen", documentId: "test.pen", nodeId: "node" },
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    width: { mode: "fixed", value: 100 },
    height: { mode: "fixed", value: 100 },
    rotation: 0,
    visible: true,
    opacity: 1,
    locked: false,
    children: [],
    ...overrides,
  };
}

function document(root: BridgeNode): BridgeDocument {
  return {
    version: 1,
    source: { app: "pen", documentId: "test.pen" },
    root,
    assets: [],
    variables: [],
    warnings: [],
  };
}

describe("Figma geometry normalization", () => {
  it("preserves negative gaps and geometry supported by frames", () => {
    const root = node({
      bridgeId: "pen:frame",
      kind: "frame",
      layout: {
        mode: "horizontal",
        gap: -8,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        primaryAlign: "start",
        counterAlign: "start",
        includeStroke: true,
      },
      cornerRadii: [4, 8, 12, 16],
      stroke: {
        paints: [],
        alignment: "inside",
        weights: { top: 1, right: 2, bottom: 3, left: 4 },
        cap: "none",
        join: "miter",
      },
    });
    const value = document(root);

    normalizeGeometryForFigma(value);

    expect(root.layout?.gap).toBe(-8);
    expect(root.cornerRadii).toEqual([4, 8, 12, 16]);
    expect(root.stroke?.weights).toEqual({
      top: 1,
      right: 2,
      bottom: 3,
      left: 4,
    });
    expect(value.warnings).toEqual([]);
  });

  it("flattens unsupported per-side geometry deterministically", () => {
    const root = node({
      bridgeId: "pen:polygon",
      kind: "polygon",
      cornerRadii: [4, 8, 12, 16],
      stroke: {
        paints: [],
        alignment: "inside",
        weights: { top: 1, right: 2, bottom: 3, left: 4 },
        cap: "none",
        join: "miter",
      },
    });
    const value = document(root);

    normalizeGeometryForFigma(value);
    normalizeGeometryForFigma(value);

    expect(root.cornerRadii).toEqual([10, 10, 10, 10]);
    expect(root.stroke?.weights).toEqual({
      top: 2.5,
      right: 2.5,
      bottom: 2.5,
      left: 2.5,
    });
    expect(value.warnings.map((warning) => warning.code)).toEqual([
      "PEN_STROKE_WEIGHTS_FLATTENED",
      "PEN_CORNER_RADII_FLATTENED",
    ]);
  });

  it("removes radii from layer types that cannot represent them", () => {
    const root = node({
      bridgeId: "pen:text",
      kind: "text",
      cornerRadii: [8, 8, 8, 8],
    });
    const value = document(root);

    normalizeGeometryForFigma(value);

    expect(root.cornerRadii).toBeUndefined();
    expect(value.warnings).toContainEqual(
      expect.objectContaining({
        code: "PEN_CORNER_RADII_SKIPPED",
        action: "skip",
      }),
    );
  });

  it("normalizes a zero uniform radius to the absent Figma default", () => {
    const root = node({
      bridgeId: "pen:ellipse",
      kind: "ellipse",
      cornerRadii: [0, 0, 0, 0],
    });
    const value = document(root);

    normalizeGeometryForFigma(value);

    expect(root.cornerRadii).toBeUndefined();
    expect(value.warnings).toEqual([]);
  });

  it("uses the arithmetic mean as the stable fallback", () => {
    expect(uniformValue([1, 2, 3, 4])).toBe(2.5);
  });
});
