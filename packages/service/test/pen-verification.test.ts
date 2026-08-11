import { describe, expect, it } from "vitest";
import type { BridgeDocument, BridgeNode } from "@pen-fig/bridge-schema";
import { verifyPencilWriteFidelity } from "../src/export/pen-verification.js";

function node(overrides: Partial<BridgeNode>): BridgeNode {
  return {
    bridgeId: "figma:node",
    kind: "rectangle",
    name: "Scrim",
    source: { app: "figma", documentId: "figma-local", nodeId: "node" },
    bounds: { x: 0, y: 344, width: 393, height: 500 },
    width: { mode: "fixed", value: 393 },
    height: { mode: "fixed", value: 500 },
    rotation: 0,
    visible: true,
    opacity: 1,
    locked: false,
    layoutPosition: "absolute",
    children: [],
    ...overrides,
  };
}

function document(root: BridgeNode): BridgeDocument {
  return {
    version: 1,
    source: { app: root.source.app, documentId: root.source.documentId },
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

function scrim(transform = downward): BridgeNode {
  return node({
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
}

describe("Pencil write verification", () => {
  it("accepts matching geometry and gradient direction", () => {
    expect(() =>
      verifyPencilWriteFidelity(document(scrim()), document(scrim())),
    ).not.toThrow();
  });

  it("accepts a normalized transform with the same direction", () => {
    const scaled = [
      [0, 2, 0],
      [-2, 0, 1],
    ] as [[number, number, number], [number, number, number]];
    expect(() =>
      verifyPencilWriteFidelity(document(scrim(scaled)), document(scrim())),
    ).not.toThrow();
  });

  it("rejects a reversed gradient", () => {
    expect(() =>
      verifyPencilWriteFidelity(document(scrim()), document(scrim(upward))),
    ).toThrow("Scrim: gradient direction changed");
  });

  it("rejects changed absolute geometry", () => {
    expect(() =>
      verifyPencilWriteFidelity(
        document(scrim()),
        document(
          node({ ...scrim(), bounds: { x: 0, y: 0, width: 393, height: 500 } }),
        ),
      ),
    ).toThrow("Scrim: expected y 344, received 0");
  });
});
