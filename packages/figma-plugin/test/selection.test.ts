import { describe, expect, it } from "vitest";
import {
  resolveFigmaExportRoot,
  resolveFigmaExportRoots,
} from "../src/figma/read.js";

interface MockNode {
  id: string;
  name: string;
  type: string;
  parent: MockNode | null;
  children?: MockNode[];
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

  it("collects layers from different screens for batch export", () => {
    const page = node("page", "PAGE", null);
    const firstScreen = node("first", "FRAME", page);
    const secondScreen = node("second", "FRAME", page);
    const firstTitle = node("first-title", "TEXT", firstScreen);
    const secondTitle = node("second-title", "TEXT", secondScreen);

    expect(resolveFigmaExportRoots(selection(firstTitle, secondTitle))).toEqual(
      [firstScreen, secondScreen],
    );
  });

  it("still requires one screen for mapped comparison", () => {
    const page = node("page", "PAGE", null);
    const firstScreen = node("first", "FRAME", page);
    const secondScreen = node("second", "FRAME", page);

    expect(() =>
      resolveFigmaExportRoot(selection(firstScreen, secondScreen)),
    ).toThrow("Select one Figma screen for comparison");
  });

  it("collects every screen inside a selected Figma section", () => {
    const page = node("page", "PAGE", null);
    const section = node("section", "SECTION", page, "Onboarding");
    const firstScreen = node("first", "FRAME", section);
    const secondScreen = node("second", "FRAME", section);
    section.children = [firstScreen, secondScreen];

    expect(resolveFigmaExportRoots(selection(section))).toEqual([
      firstScreen,
      secondScreen,
    ]);
  });

  it("gives a clear message when nothing is selected", () => {
    expect(() => resolveFigmaExportRoot([])).toThrow(
      "Select a Figma screen, or any layer inside it",
    );
  });
});
