import { describe, expect, it } from "vitest";
import type { BridgeDocument, BridgeNode } from "@pen-fig/bridge-schema";
import { verifyFigmaWriteFidelity } from "../src/figma/verification.js";

function node(overrides: Partial<BridgeNode>): BridgeNode {
  return {
    bridgeId: "pen:node",
    kind: "frame",
    name: "Node",
    source: { app: "pen", documentId: "test.pen", nodeId: "node" },
    bounds: { x: 0, y: 0, width: 393, height: 844 },
    width: { mode: "fixed", value: 393 },
    height: { mode: "fixed", value: 844 },
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

const transparent = { r: 0.1, g: 0.08, b: 0.07, a: 0 };
const opaque = { r: 0.1, g: 0.08, b: 0.07, a: 1 };
const downward = [
  [0, 1, 0],
  [-1, 0, 1],
] as [[number, number, number], [number, number, number]];
const upward = [
  [0, -1, 1],
  [1, 0, 0],
] as [[number, number, number], [number, number, number]];

function overlayRoot(transform = downward): BridgeNode {
  const status = node({
    bridgeId: "pen:status",
    name: "Status Bar",
    bounds: { x: 0, y: 0, width: 393, height: 56 },
    height: { mode: "fixed", value: 56 },
  });
  const scrim = node({
    bridgeId: "pen:scrim",
    kind: "rectangle",
    name: "Scrim",
    bounds: { x: 0, y: 344, width: 393, height: 500 },
    height: { mode: "fixed", value: 500 },
    fills: [
      {
        type: "gradient",
        visible: true,
        opacity: 1,
        blendMode: "normal",
        gradientType: "linear",
        stops: [
          { color: transparent, position: 0 },
          { color: opaque, position: 0.72 },
        ],
        transform,
      },
    ],
  });
  const photo = node({
    bridgeId: "pen:photo",
    name: "Photo",
    layoutPosition: "absolute",
    children: [scrim],
  });
  const copy = node({
    bridgeId: "pen:copy",
    name: "Copy",
    bounds: { x: 0, y: 56, width: 393, height: 788 },
    height: { mode: "fixed", value: 788 },
  });
  return node({ bridgeId: "pen:root", children: [status, photo, copy] });
}

describe("Figma write verification", () => {
  it("accepts the expected background stack and downward scrim", () => {
    const source = overlayRoot();
    const actual = structuredClone(source);
    actual.children = [
      actual.children[1]!,
      actual.children[0]!,
      actual.children[2]!,
    ];

    expect(() =>
      verifyFigmaWriteFidelity(document(source), document(actual)),
    ).not.toThrow();
  });

  it("rejects a reversed scrim gradient", () => {
    const source = overlayRoot();
    const actual = overlayRoot(upward);
    actual.children = [
      actual.children[1]!,
      actual.children[0]!,
      actual.children[2]!,
    ];

    expect(() =>
      verifyFigmaWriteFidelity(document(source), document(actual)),
    ).toThrow("Scrim: gradient direction changed");
  });

  it("rejects a full-screen photo above the status bar", () => {
    const source = overlayRoot();
    const actual = structuredClone(source);

    expect(() =>
      verifyFigmaWriteFidelity(document(source), document(actual)),
    ).toThrow("layer order was not preserved");
  });

  it("accepts tighter Figma bounds for an SVG-derived icon wrapper", () => {
    const source = node({
      bridgeId: "pen:signal",
      kind: "frame",
      name: "I",
      bounds: { x: 0, y: 0, width: 16, height: 16 },
      width: { mode: "fixed", value: 16 },
      height: { mode: "fixed", value: 16 },
      icon: { assetId: "pen-icon:signal" },
    });
    const actual = structuredClone(source);
    actual.bounds.width = 10.000006675720215;
    actual.bounds.height = 15.168421745300293;

    expect(() =>
      verifyFigmaWriteFidelity(document(source), document(actual)),
    ).not.toThrow();
  });

  it("continues to reject the same width drift for normal layers", () => {
    const source = node({
      bridgeId: "pen:card",
      name: "Card",
      bounds: { x: 0, y: 0, width: 16, height: 16 },
      width: { mode: "fixed", value: 16 },
      height: { mode: "fixed", value: 16 },
    });
    const actual = structuredClone(source);
    actual.bounds.width = 10;

    expect(() =>
      verifyFigmaWriteFidelity(document(source), document(actual)),
    ).toThrow("Card: expected width 16, received 10");
  });
});
