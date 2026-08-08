export interface BaselineNodeSnapshot {
  bridgeId: string;
  baselineHash: string;
  penBaselineHash?: string | undefined;
  figmaBaselineHash?: string | undefined;
}

export interface CurrentNodeSnapshot {
  bridgeId: string;
  nodeId: string;
  parentBridgeId: string | undefined;
  authoredHash: string;
}

export type ThreeWayClassification =
  | "unchanged"
  | "pen-only"
  | "figma-only"
  | "conflicted"
  | "added"
  | "deleted"
  | "unmapped";

export type ChangedSide = "pen" | "figma" | "both";

export interface ThreeWayDiffEntry {
  bridgeId: string;
  classification: ThreeWayClassification;
  baselineHash: string | undefined;
  pen: CurrentNodeSnapshot | undefined;
  figma: CurrentNodeSnapshot | undefined;
  penChanged: boolean;
  figmaChanged: boolean;
  side: ChangedSide | undefined;
  reason: "two-sided-edit" | "delete-vs-edit" | undefined;
  baselineAdvanced: boolean;
}

export interface ThreeWayDiff {
  entries: ThreeWayDiffEntry[];
  counts: Record<ThreeWayClassification, number>;
  conflictRoots: ThreeWayDiffEntry[];
  canApplyWithoutResolution: boolean;
}

export function snapshotBridgeDocument(
  document: BridgeDocument,
): CurrentNodeSnapshot[] {
  const hashes = authoredDocumentHashes(document);
  const snapshots: CurrentNodeSnapshot[] = [];
  const visit = (node: BridgeNode, parentBridgeId: string | undefined) => {
    snapshots.push({
      bridgeId: node.bridgeId,
      nodeId: node.source.nodeId,
      parentBridgeId,
      authoredHash: hashes[node.bridgeId]!,
    });
    for (const child of node.children) visit(child, node.bridgeId);
  };
  visit(document.root, undefined);
  return snapshots;
}

export function classifyThreeWayDiff(
  baseline: BaselineNodeSnapshot[],
  currentPen: CurrentNodeSnapshot[],
  currentFigma: CurrentNodeSnapshot[],
): ThreeWayDiff {
  const baselineById = uniqueByBridgeId(baseline, "baseline");
  const penById = uniqueByBridgeId(currentPen, "Pencil");
  const figmaById = uniqueByBridgeId(currentFigma, "Figma");
  const bridgeIds = orderedUnion(
    baseline.map((entry) => entry.bridgeId),
    currentPen.map((entry) => entry.bridgeId),
    currentFigma.map((entry) => entry.bridgeId),
  );
  const entries = bridgeIds.map((bridgeId) =>
    classifyEntry(
      bridgeId,
      baselineById.get(bridgeId),
      penById.get(bridgeId),
      figmaById.get(bridgeId),
    ),
  );
  const conflictRoots = smallestConflictRoots(entries);
  return {
    entries,
    counts: countClassifications(entries),
    conflictRoots,
    canApplyWithoutResolution:
      conflictRoots.length === 0 &&
      !entries.some((entry) => entry.classification === "unmapped"),
  };
}

function classifyEntry(
  bridgeId: string,
  baseline: BaselineNodeSnapshot | undefined,
  pen: CurrentNodeSnapshot | undefined,
  figma: CurrentNodeSnapshot | undefined,
): ThreeWayDiffEntry {
  if (!baseline) {
    if (pen && figma)
      return entry(bridgeId, "unmapped", undefined, pen, figma, {
        side: "both",
      });
    return entry(bridgeId, "added", undefined, pen, figma, {
      side: pen ? "pen" : "figma",
    });
  }

  const penBaselineHash = baseline.penBaselineHash ?? baseline.baselineHash;
  const figmaBaselineHash = baseline.figmaBaselineHash ?? baseline.baselineHash;
  const penChanged = Boolean(pen && pen.authoredHash !== penBaselineHash);
  const figmaChanged = Boolean(
    figma && figma.authoredHash !== figmaBaselineHash,
  );
  if (!pen && !figma)
    return entry(bridgeId, "deleted", baseline.baselineHash, pen, figma, {
      side: "both",
    });
  if (!pen || !figma) {
    const survivingSide = pen ? "pen" : "figma";
    const survivorChanged = pen ? penChanged : figmaChanged;
    if (survivorChanged)
      return entry(bridgeId, "conflicted", baseline.baselineHash, pen, figma, {
        penChanged: !pen || penChanged,
        figmaChanged: !figma || figmaChanged,
        side: "both",
        reason: "delete-vs-edit",
      });
    return entry(bridgeId, "deleted", baseline.baselineHash, pen, figma, {
      penChanged: !pen,
      figmaChanged: !figma,
      side: survivingSide === "pen" ? "figma" : "pen",
    });
  }

  if (!penChanged && !figmaChanged)
    return entry(bridgeId, "unchanged", baseline.baselineHash, pen, figma);
  if (penChanged && !figmaChanged)
    return entry(bridgeId, "pen-only", baseline.baselineHash, pen, figma, {
      penChanged: true,
      side: "pen",
    });
  if (!penChanged && figmaChanged)
    return entry(bridgeId, "figma-only", baseline.baselineHash, pen, figma, {
      figmaChanged: true,
      side: "figma",
    });
  if (pen.authoredHash === figma.authoredHash)
    return entry(bridgeId, "unchanged", baseline.baselineHash, pen, figma, {
      penChanged: true,
      figmaChanged: true,
      side: "both",
      baselineAdvanced: true,
    });
  return entry(bridgeId, "conflicted", baseline.baselineHash, pen, figma, {
    penChanged: true,
    figmaChanged: true,
    side: "both",
    reason: "two-sided-edit",
  });
}

function entry(
  bridgeId: string,
  classification: ThreeWayClassification,
  baselineHash: string | undefined,
  pen: CurrentNodeSnapshot | undefined,
  figma: CurrentNodeSnapshot | undefined,
  options: {
    penChanged?: boolean;
    figmaChanged?: boolean;
    side?: ChangedSide;
    reason?: ThreeWayDiffEntry["reason"];
    baselineAdvanced?: boolean;
  } = {},
): ThreeWayDiffEntry {
  return {
    bridgeId,
    classification,
    baselineHash,
    pen,
    figma,
    penChanged: options.penChanged ?? false,
    figmaChanged: options.figmaChanged ?? false,
    side: options.side,
    reason: options.reason,
    baselineAdvanced: options.baselineAdvanced ?? false,
  };
}

function smallestConflictRoots(
  entries: ThreeWayDiffEntry[],
): ThreeWayDiffEntry[] {
  const entryById = new Map(entries.map((entry) => [entry.bridgeId, entry]));
  return entries.filter((candidate) => {
    if (candidate.classification !== "conflicted") return false;
    let parentId =
      candidate.pen?.parentBridgeId ?? candidate.figma?.parentBridgeId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = entryById.get(parentId);
      if (!parent) break;
      if (parent.classification === "conflicted") return false;
      parentId = parent.pen?.parentBridgeId ?? parent.figma?.parentBridgeId;
    }
    return true;
  });
}

function uniqueByBridgeId<T extends { bridgeId: string }>(
  entries: T[],
  side: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    if (result.has(entry.bridgeId))
      throw new Error(`Duplicate ${side} bridge identity ${entry.bridgeId}`);
    result.set(entry.bridgeId, entry);
  }
  return result;
}

function orderedUnion(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of lists)
    for (const value of list)
      if (!seen.has(value)) {
        seen.add(value);
        result.push(value);
      }
  return result;
}

function countClassifications(
  entries: ThreeWayDiffEntry[],
): Record<ThreeWayClassification, number> {
  const counts: Record<ThreeWayClassification, number> = {
    unchanged: 0,
    "pen-only": 0,
    "figma-only": 0,
    conflicted: 0,
    added: 0,
    deleted: 0,
    unmapped: 0,
  };
  for (const entry of entries) counts[entry.classification] += 1;
  return counts;
}
import type { BridgeDocument, BridgeNode } from "@pen-fig/bridge-schema";
import { authoredDocumentHashes } from "../hash.js";
