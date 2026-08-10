import { describe, expect, it } from "vitest";
import { resolveFigmaExportRoot } from "../src/figma/read.js";

interface MockNode {
  id: string;
  name: string;
  type: string;
  parent: MockNode | null;
}

function node(
  id: string,
  type: string,
  parent: MockNode | null,
  name = id,
): MockNode {
  return { id, name, type, parent };
}

function selection(...nodes: MockNode[]): SceneNode[] {
  return nodes as unknown as SceneNode[];
}

describe("Figma export selection", () => {
  it("uses the screen when a nested layer is selected", () => {
    const page = node("page", "PAGE", null);
    const screen = node("screen", "FRAME", page);
    const card = node("card", "FRAME", screen);
    const title = node("title", "TEXT", card);

    expect(resolveFigmaExportRoot(selection(title))).toBe(screen);
  });

  it("accepts multiple layers from the same screen", () => {
    const page = node("page", "PAGE", null);
    const screen = node("screen", "FRAME", page);
    const title = node("title", "TEXT", screen);
    const body = node("body", "TEXT", screen);

    expect(resolveFigmaExportRoot(selection(title, body))).toBe(screen);
  });

  it("rejects layers from different screens", () => {
    const page = node("page", "PAGE", null);
    const firstScreen = node("first", "FRAME", page);
    const secondScreen = node("second", "FRAME", page);
    const firstTitle = node("first-title", "TEXT", firstScreen);
    const secondTitle = node("second-title", "TEXT", secondScreen);

    expect(() =>
      resolveFigmaExportRoot(selection(firstTitle, secondTitle)),
    ).toThrow("different screens");
  });

  it("gives a clear message when nothing is selected", () => {
    expect(() => resolveFigmaExportRoot([])).toThrow(
      "Select a Figma screen, or any layer inside it",
    );
  });
});
