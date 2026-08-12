import type { BridgeNode } from "@pen-fig/bridge-schema";
import { describe, expect, it } from "vitest";
import {
  autoLayoutFillFallback,
  mustPreserveHugFallback,
} from "../src/figma/sizing.js";

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

function sizingNode(overrides: Partial<BridgeNode>): BridgeNode {
  return {
    bridgeId: "pen:frame",
    kind: "frame",
    name: "Frame 40",
    source: { app: "pen", documentId: "test.pen", nodeId: "frame" },
    bounds: { x: 0, y: 0, width: 345, height: 100 },
    width: { mode: "hug", fallback: 345 },
    height: { mode: "hug", fallback: 100 },
    rotation: 0,
    visible: true,
    opacity: 1,
    locked: false,
    children: [],
    layout: {
      mode: "vertical",
      gap: 12,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      primaryAlign: "start",
      counterAlign: "start",
    },
    ...overrides,
  };
}

describe("mustPreserveHugFallback", () => {
  it("preserves a Pencil hug width whose child fills that width", () => {
    const source = sizingNode({
      children: [
        sizingNode({
          bridgeId: "pen:section",
          name: "Sect",
          width: { mode: "fill" },
          height: { mode: "hug", fallback: 20 },
        }),
      ],
    });

    expect(mustPreserveHugFallback(source, "horizontal")).toBe(true);
  });

  it("keeps normal content-driven hug sizing dynamic", () => {
    const source = sizingNode({
      children: [
        sizingNode({
          bridgeId: "pen:label",
          name: "Label",
          width: { mode: "fixed", value: 120 },
          height: { mode: "fixed", value: 20 },
        }),
      ],
    });

    expect(mustPreserveHugFallback(source, "horizontal")).toBe(false);
  });

  it("preserves a resolved top-level Pencil screen without freezing nested hug frames", () => {
    const root = sizingNode({
      bridgeId: "pen:preferences",
      name: "P2 · Preferences",
      height: { mode: "hug", fallback: 875 },
      children: [
        sizingNode({
          bridgeId: "pen:content",
          name: "Content",
          width: { mode: "fixed", value: 393 },
          height: { mode: "hug", fallback: 783 },
        }),
      ],
    });

    expect(
      mustPreserveHugFallback(root, "vertical", "pen:preferences"),
    ).toBe(true);
    expect(
      mustPreserveHugFallback(root.children[0]!, "vertical", "pen:preferences"),
    ).toBe(false);
  });
});
