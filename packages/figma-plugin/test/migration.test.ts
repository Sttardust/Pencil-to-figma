import { describe, expect, it } from "vitest";
import type { BridgeNode } from "@pen-fig/bridge-schema";
import { needsOverlayLayoutRebuild } from "../src/figma/migration.js";

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

describe("needsOverlayLayoutRebuild", () => {
  it("detects a Pencil screen with an absolute photo and fill-height copy", () => {
    const root = node({
      layout: {
        mode: "vertical",
        gap: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        primaryAlign: "start",
        counterAlign: "start",
        includeStroke: false,
      },
      children: [
        node({ bridgeId: "pen:photo", layoutPosition: "absolute" }),
        node({ bridgeId: "pen:copy", height: { mode: "fill" } }),
      ],
    });

    expect(needsOverlayLayoutRebuild(root)).toBe(true);
  });

  it("does not rebuild ordinary auto-layout screens", () => {
    const root = node({
      layout: {
        mode: "vertical",
        gap: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        primaryAlign: "start",
        counterAlign: "start",
        includeStroke: false,
      },
      children: [node({ bridgeId: "pen:content", height: { mode: "fill" } })],
    });

    expect(needsOverlayLayoutRebuild(root)).toBe(false);
  });
});
