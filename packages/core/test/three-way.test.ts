import { describe, expect, it } from "vitest";
import {
  classifyThreeWayDiff,
  type BaselineNodeSnapshot,
  type CurrentNodeSnapshot,
} from "../src/index.js";

const BASELINE = hash("a");
const PEN_EDIT = hash("b");
const FIGMA_EDIT = hash("c");

describe("classifyThreeWayDiff", () => {
  it("classifies the four basic three-way cases", () => {
    const baseline = ["unchanged", "pen", "figma", "conflict"].map(base);
    const pen = [
      current("unchanged", BASELINE),
      current("pen", PEN_EDIT),
      current("figma", BASELINE),
      current("conflict", PEN_EDIT),
    ];
    const figma = [
      current("unchanged", BASELINE),
      current("pen", BASELINE),
      current("figma", FIGMA_EDIT),
      current("conflict", FIGMA_EDIT),
    ];

    const result = classifyThreeWayDiff(baseline, pen, figma);

    expect(classifications(result)).toEqual({
      unchanged: "unchanged",
      pen: "pen-only",
      figma: "figma-only",
      conflict: "conflicted",
    });
    expect(result.counts).toMatchObject({
      unchanged: 1,
      "pen-only": 1,
      "figma-only": 1,
      conflicted: 1,
    });
    expect(result.canApplyWithoutResolution).toBe(false);
    expect(result.conflictRoots.map((entry) => entry.bridgeId)).toEqual([
      "conflict",
    ]);
  });

  it("advances the baseline without a conflict when both sides converge", () => {
    const result = classifyThreeWayDiff(
      [base("node")],
      [current("node", PEN_EDIT)],
      [current("node", PEN_EDIT)],
    );

    expect(result.entries[0]).toMatchObject({
      classification: "unchanged",
      penChanged: true,
      figmaChanged: true,
      baselineAdvanced: true,
    });
    expect(result.canApplyWithoutResolution).toBe(true);
  });

  it("distinguishes clean deletions from delete-vs-edit conflicts", () => {
    const cleanPenDelete = classifyThreeWayDiff(
      [base("node")],
      [],
      [current("node", BASELINE)],
    ).entries[0]!;
    expect(cleanPenDelete).toMatchObject({
      classification: "deleted",
      side: "pen",
      penChanged: true,
      figmaChanged: false,
    });

    const conflict = classifyThreeWayDiff(
      [base("node")],
      [],
      [current("node", FIGMA_EDIT)],
    ).entries[0]!;
    expect(conflict).toMatchObject({
      classification: "conflicted",
      side: "both",
      reason: "delete-vs-edit",
      penChanged: true,
      figmaChanged: true,
    });

    const bothDeleted = classifyThreeWayDiff([base("node")], [], [])
      .entries[0]!;
    expect(bothDeleted).toMatchObject({
      classification: "deleted",
      side: "both",
    });
  });

  it("marks new one-sided identities as added and two-sided identities as unmapped", () => {
    const result = classifyThreeWayDiff(
      [],
      [current("pen-added", PEN_EDIT), current("shared", PEN_EDIT)],
      [current("figma-added", FIGMA_EDIT), current("shared", PEN_EDIT)],
    );

    expect(classifications(result)).toEqual({
      "pen-added": "added",
      shared: "unmapped",
      "figma-added": "added",
    });
    expect(
      result.entries.find((entry) => entry.bridgeId === "pen-added")?.side,
    ).toBe("pen");
    expect(
      result.entries.find((entry) => entry.bridgeId === "figma-added")?.side,
    ).toBe("figma");
    expect(result.canApplyWithoutResolution).toBe(false);
  });

  it("reports only the smallest independently writable conflict roots", () => {
    const baseline = [base("root"), base("child"), base("grandchild")];
    const pen = [
      current("root", PEN_EDIT),
      current("child", PEN_EDIT, "root"),
      current("grandchild", PEN_EDIT, "child"),
    ];
    const figma = [
      current("root", FIGMA_EDIT),
      current("child", FIGMA_EDIT, "root"),
      current("grandchild", FIGMA_EDIT, "child"),
    ];

    const result = classifyThreeWayDiff(baseline, pen, figma);

    expect(result.counts.conflicted).toBe(3);
    expect(result.conflictRoots.map((entry) => entry.bridgeId)).toEqual([
      "root",
    ]);
  });

  it("rejects duplicate identities independently on every side", () => {
    expect(() =>
      classifyThreeWayDiff([base("same"), base("same")], [], []),
    ).toThrow("Duplicate baseline bridge identity same");
    expect(() =>
      classifyThreeWayDiff(
        [],
        [current("same", BASELINE), current("same", BASELINE)],
        [],
      ),
    ).toThrow("Duplicate Pencil bridge identity same");
    expect(() =>
      classifyThreeWayDiff(
        [],
        [],
        [current("same", BASELINE), current("same", BASELINE)],
      ),
    ).toThrow("Duplicate Figma bridge identity same");
  });
});

function base(bridgeId: string): BaselineNodeSnapshot {
  return { bridgeId, baselineHash: BASELINE };
}

function current(
  bridgeId: string,
  authoredHash: string,
  parentBridgeId?: string,
): CurrentNodeSnapshot {
  return {
    bridgeId,
    nodeId: `${bridgeId}-native`,
    parentBridgeId,
    authoredHash,
  };
}

function classifications(result: ReturnType<typeof classifyThreeWayDiff>) {
  return Object.fromEntries(
    result.entries.map((entry) => [entry.bridgeId, entry.classification]),
  );
}

function hash(character: string): string {
  return character.repeat(64);
}
