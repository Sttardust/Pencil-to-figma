import { describe, expect, it } from "vitest";
import {
  authoredDocumentHashes,
  importPenDocument,
  planPenToFigmaSync,
  type ExistingNodeSnapshot,
  type PenNode,
} from "../src/index.js";

function document(children: PenNode[]) {
  return importPenDocument(
    { id: "root", type: "frame", width: 100, height: 100, children },
    { documentId: "test.pen" },
  );
}

function snapshot(input: ReturnType<typeof document>): ExistingNodeSnapshot[] {
  const hashes = authoredDocumentHashes(input);
  const result: ExistingNodeSnapshot[] = [];
  const visit = (
    node: (typeof input)["root"],
    parentBridgeId: string | undefined,
    index: number,
  ) => {
    result.push({
      bridgeId: node.bridgeId,
      nodeId: `figma:${node.bridgeId}`,
      parentBridgeId,
      index,
      authoredHash: hashes[node.bridgeId]!,
    });
    node.children.forEach((child, childIndex) =>
      visit(child, node.bridgeId, childIndex),
    );
  };
  visit(input.root, undefined, 0);
  return result;
}

describe("planPenToFigmaSync", () => {
  it("returns no operations for an unchanged mapped tree", () => {
    const input = document([{ id: "one", type: "text", content: "One" }]);
    expect(planPenToFigmaSync(input, snapshot(input))).toEqual({
      operations: [],
      counts: { create: 0, update: 0, move: 0, delete: 0 },
    });
  });

  it("plans parent-before-child creates", () => {
    const input = document([
      {
        id: "new-parent",
        type: "frame",
        children: [{ id: "new-child", type: "text", content: "New" }],
      },
    ]);
    const existing = snapshot(document([]));
    const plan = planPenToFigmaSync(input, existing);
    expect(plan.operations.map((operation) => operation.type)).toEqual([
      "update",
      "create",
      "create",
    ]);
    expect(
      plan.operations.slice(1).map((operation) => operation.bridgeId),
    ).toEqual(["pen:new-parent", "pen:new-child"]);
  });

  it("plans edits, reorders, and child-before-parent deletes", () => {
    const before = document([
      {
        id: "removed-parent",
        type: "frame",
        children: [{ id: "removed-child", type: "text", content: "Old" }],
      },
      { id: "one", type: "text", content: "One" },
      { id: "two", type: "text", content: "Two" },
    ]);
    const after = document([
      { id: "two", type: "text", content: "Changed" },
      { id: "one", type: "text", content: "One" },
    ]);
    const plan = planPenToFigmaSync(after, snapshot(before));

    expect(plan.counts).toEqual({ create: 0, update: 2, move: 1, delete: 2 });
    expect(
      plan.operations.filter((operation) => operation.type === "delete"),
    ).toEqual([
      expect.objectContaining({ bridgeId: "pen:removed-child" }),
      expect.objectContaining({ bridgeId: "pen:removed-parent" }),
    ]);
  });

  it("rejects duplicate existing identities", () => {
    const input = document([]);
    const existing = snapshot(input);
    expect(() =>
      planPenToFigmaSync(input, [
        ...existing,
        { ...existing[0]!, nodeId: "2:2" },
      ]),
    ).toThrow("Duplicate bridge identity pen:root");
  });
});
