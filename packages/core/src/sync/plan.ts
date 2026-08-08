import type { BridgeDocument, BridgeNode } from "@pen-fig/bridge-schema";
import { authoredDocumentHashes } from "../hash.js";

export interface ExistingNodeSnapshot {
  bridgeId: string;
  nodeId: string;
  parentBridgeId: string | undefined;
  index: number;
  authoredHash: string;
}

export type SyncOperation =
  | {
      type: "create";
      bridgeId: string;
      parentBridgeId: string | undefined;
      index: number;
    }
  | { type: "update"; bridgeId: string; nodeId: string }
  | {
      type: "move";
      bridgeId: string;
      nodeId: string;
      parentBridgeId: string | undefined;
      index: number;
    }
  | { type: "delete"; bridgeId: string; nodeId: string };

export interface SyncPlan {
  operations: SyncOperation[];
  counts: { create: number; update: number; move: number; delete: number };
}

interface ExpectedNode {
  node: BridgeNode;
  parentBridgeId: string | undefined;
  index: number;
  depth: number;
  authoredHash: string;
}

export function planPenToFigmaSync(
  document: BridgeDocument,
  existing: ExistingNodeSnapshot[],
): SyncPlan {
  const expected = flattenExpected(document);
  const existingById = uniqueExisting(existing);
  const expectedById = new Map(
    expected.map((entry) => [entry.node.bridgeId, entry]),
  );
  const operations: SyncOperation[] = [];

  for (const entry of expected) {
    const current = existingById.get(entry.node.bridgeId);
    if (!current) {
      operations.push({
        type: "create",
        bridgeId: entry.node.bridgeId,
        parentBridgeId: entry.parentBridgeId,
        index: entry.index,
      });
      continue;
    }
    if (current.authoredHash !== entry.authoredHash)
      operations.push({
        type: "update",
        bridgeId: entry.node.bridgeId,
        nodeId: current.nodeId,
      });
    if (
      entry.parentBridgeId !== undefined &&
      (current.parentBridgeId !== entry.parentBridgeId ||
        current.index !== entry.index)
    )
      operations.push({
        type: "move",
        bridgeId: entry.node.bridgeId,
        nodeId: current.nodeId,
        parentBridgeId: entry.parentBridgeId,
        index: entry.index,
      });
  }

  const deleted = existing
    .filter((entry) => !expectedById.has(entry.bridgeId))
    .sort(
      (left, right) =>
        depthOf(right, existingById) - depthOf(left, existingById),
    );
  for (const entry of deleted)
    operations.push({
      type: "delete",
      bridgeId: entry.bridgeId,
      nodeId: entry.nodeId,
    });

  return { operations, counts: countOperations(operations) };
}

function flattenExpected(document: BridgeDocument): ExpectedNode[] {
  const hashes = authoredDocumentHashes(document);
  const result: ExpectedNode[] = [];
  const visit = (
    node: BridgeNode,
    parentBridgeId: string | undefined,
    index: number,
    depth: number,
  ) => {
    result.push({
      node,
      parentBridgeId,
      index,
      depth,
      authoredHash: hashes[node.bridgeId]!,
    });
    node.children.forEach((child, childIndex) =>
      visit(child, node.bridgeId, childIndex, depth + 1),
    );
  };
  visit(document.root, undefined, 0, 0);
  return result;
}

function uniqueExisting(
  existing: ExistingNodeSnapshot[],
): Map<string, ExistingNodeSnapshot> {
  const result = new Map<string, ExistingNodeSnapshot>();
  for (const entry of existing) {
    if (result.has(entry.bridgeId))
      throw new Error(`Duplicate bridge identity ${entry.bridgeId}`);
    result.set(entry.bridgeId, entry);
  }
  return result;
}

function depthOf(
  entry: ExistingNodeSnapshot,
  existing: Map<string, ExistingNodeSnapshot>,
): number {
  let depth = 0;
  let parentId = entry.parentBridgeId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = existing.get(parentId)?.parentBridgeId;
  }
  return depth;
}

function countOperations(operations: SyncOperation[]): SyncPlan["counts"] {
  const counts = { create: 0, update: 0, move: 0, delete: 0 };
  for (const operation of operations) counts[operation.type] += 1;
  return counts;
}
