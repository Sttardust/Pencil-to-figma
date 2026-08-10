import { describe, expect, it } from "vitest";
import type { BridgeNode } from "@pen-fig/bridge-schema";
import {
  bridgeStackOrder,
  isFullCoverAbsoluteBackground,
} from "../src/figma/stacking.js";

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

describe("Pencil overlay stacking", () => {
  it("places a full-screen absolute photo behind flow content", () => {
    const status = node({
      bridgeId: "pen:status",
      name: "Status Bar",
      bounds: { x: 0, y: 0, width: 393, height: 56 },
    });
    const photo = node({
      bridgeId: "pen:photo",
      name: "Photo",
      layoutPosition: "absolute",
    });
    const copy = node({
      bridgeId: "pen:copy",
      name: "Copy",
      bounds: { x: 0, y: 56, width: 393, height: 788 },
    });
    const root = node({ children: [status, photo, copy] });

    expect(isFullCoverAbsoluteBackground(root, photo)).toBe(true);
    expect(bridgeStackOrder(root)).toEqual([
      "pen:photo",
      "pen:status",
      "pen:copy",
    ]);
  });

  it("does not move a smaller absolute overlay behind its siblings", () => {
    const badge = node({
      bridgeId: "pen:badge",
      layoutPosition: "absolute",
      bounds: { x: 20, y: 20, width: 40, height: 40 },
    });
    const content = node({ bridgeId: "pen:content" });
    const root = node({ children: [content, badge] });

    expect(isFullCoverAbsoluteBackground(root, badge)).toBe(false);
    expect(bridgeStackOrder(root)).toEqual(["pen:content", "pen:badge"]);
  });
});
