import type { BridgeDocument, BridgeManifest } from "@pen-fig/bridge-schema";
import { authoredDocumentHashes, type PenNode } from "@pen-fig/core";

export interface PenBridgeMapping {
  bridgeId: string;
  penNodeId: string;
}

export interface FigmaExportManifestOptions {
  previous?: BridgeManifest | undefined;
  penDocument?: BridgeDocument | undefined;
  updatedAt?: Date | undefined;
}

export function collectPenBridgeMappings(root: PenNode): PenBridgeMapping[] {
  const mappings: PenBridgeMapping[] = [];
  const bridgeIds = new Set<string>();
  const visit = (node: PenNode) => {
    const bridgeId = node.metadata?.bridgeId;
    if (typeof bridgeId !== "string" || !bridgeId)
      throw new Error(`Pencil node ${node.id} has no bridge identity`);
    if (bridgeIds.has(bridgeId))
      throw new Error(`Duplicate Pencil bridge identity ${bridgeId}`);
    bridgeIds.add(bridgeId);
    mappings.push({ bridgeId, penNodeId: node.id });
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return mappings;
}

export function collectMappedPenBridgeMappings(
  root: PenNode,
  expectedMappings: PenBridgeMapping[],
): PenBridgeMapping[] {
  const bridgeIdByPenNodeId = new Map<string, string>();
  const expectedBridgeIds = new Set<string>();
  for (const mapping of expectedMappings) {
    if (expectedBridgeIds.has(mapping.bridgeId))
      throw new Error(`Duplicate Pencil bridge identity ${mapping.bridgeId}`);
    if (bridgeIdByPenNodeId.has(mapping.penNodeId))
      throw new Error(`Duplicate Pencil node identity ${mapping.penNodeId}`);
    expectedBridgeIds.add(mapping.bridgeId);
    bridgeIdByPenNodeId.set(mapping.penNodeId, mapping.bridgeId);
  }

  const mappings: PenBridgeMapping[] = [];
  const visitedBridgeIds = new Set<string>();
  const visit = (node: PenNode) => {
    const bridgeId = bridgeIdByPenNodeId.get(node.id);
    if (!bridgeId)
      throw new Error(`Pencil node ${node.id} is not in the sync manifest`);
    const metadataBridgeId = node.metadata?.bridgeId;
    if (
      typeof metadataBridgeId === "string" &&
      metadataBridgeId &&
      metadataBridgeId !== bridgeId
    )
      throw new Error(
        `Pencil node ${node.id} identity ${metadataBridgeId} does not match ${bridgeId}`,
      );
    if (visitedBridgeIds.has(bridgeId))
      throw new Error(`Duplicate Pencil bridge identity ${bridgeId}`);
    visitedBridgeIds.add(bridgeId);
    mappings.push({ bridgeId, penNodeId: node.id });
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);

  const missing = expectedMappings.find(
    (mapping) => !visitedBridgeIds.has(mapping.bridgeId),
  );
  if (missing) throw new Error(`Pencil mapping missing ${missing.bridgeId}`);
  return mappings;
}

export function buildFigmaExportManifest(
  document: BridgeDocument,
  penMappings: PenBridgeMapping[],
  penPath: string,
  options: FigmaExportManifestOptions = {},
): BridgeManifest {
  const hashes = authoredDocumentHashes(document);
  const penHashes = options.penDocument
    ? authoredDocumentHashes(options.penDocument)
    : undefined;
  const penByBridgeId = uniquePenMappings(penMappings);
  const expectedBridgeIds = new Set(Object.keys(hashes));
  if (penByBridgeId.size !== expectedBridgeIds.size)
    throw new Error("Pencil mapping count does not match the Figma export");
  for (const bridgeId of penByBridgeId.keys())
    if (!expectedBridgeIds.has(bridgeId))
      throw new Error(`Pencil mapping has unexpected identity ${bridgeId}`);
  if (
    penHashes &&
    (Object.keys(penHashes).length !== expectedBridgeIds.size ||
      [...expectedBridgeIds].some((bridgeId) => !penHashes[bridgeId]))
  )
    throw new Error("Pencil baseline does not match the Figma export");

  const mappings: BridgeManifest["mappings"] = [];
  visitBridgeNodes(document.root, (node) => {
    const penMapping = penByBridgeId.get(node.bridgeId);
    if (!penMapping) throw new Error(`Pencil mapping missing ${node.bridgeId}`);
    if (node.source.app !== "figma")
      throw new Error(`Bridge node ${node.bridgeId} has no Figma source`);
    mappings.push({
      bridgeId: node.bridgeId,
      penNodeId: penMapping.penNodeId,
      figmaNodeId: node.source.nodeId,
      baselineHash: hashes[node.bridgeId]!,
      ...(penHashes?.[node.bridgeId]
        ? { penBaselineHash: penHashes[node.bridgeId] }
        : {}),
      figmaBaselineHash: hashes[node.bridgeId]!,
    });
  });
  return {
    version: 1,
    penDocumentId: penPath,
    figmaDocumentId: document.source.documentId,
    revision: (options.previous?.revision ?? -1) + 1,
    updatedAt: (options.updatedAt ?? new Date()).toISOString(),
    mappings,
  };
}

function uniquePenMappings(
  mappings: PenBridgeMapping[],
): Map<string, PenBridgeMapping> {
  const byBridgeId = new Map<string, PenBridgeMapping>();
  const penNodeIds = new Set<string>();
  for (const mapping of mappings) {
    if (byBridgeId.has(mapping.bridgeId))
      throw new Error(`Duplicate Pencil bridge identity ${mapping.bridgeId}`);
    if (penNodeIds.has(mapping.penNodeId))
      throw new Error(`Duplicate Pencil node identity ${mapping.penNodeId}`);
    byBridgeId.set(mapping.bridgeId, mapping);
    penNodeIds.add(mapping.penNodeId);
  }
  return byBridgeId;
}

function visitBridgeNodes(
  node: BridgeDocument["root"],
  callback: (node: BridgeDocument["root"]) => void,
): void {
  callback(node);
  for (const child of node.children) visitBridgeNodes(child, callback);
}
