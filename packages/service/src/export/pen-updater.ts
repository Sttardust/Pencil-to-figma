import type { BridgeDocument } from "@pen-fig/bridge-schema";
import {
  planFigmaToPenCreate,
  type PenInsertOperation,
  type PenNode,
} from "@pen-fig/core";
import type { FigmaExportAssetData } from "./pen-writer.js";
import { stageFigmaAssets } from "./pen-writer.js";
import type { PenMcpClient } from "../pen/mcp-client.js";
import {
  collectMappedPenBridgeMappings,
  type PenBridgeMapping,
} from "../manifest/figma-export.js";

const MAX_UPDATE_OPERATIONS = 40;
const MAX_UPDATE_BYTES = 48 * 1024;

export interface PenUpdateResult {
  operation: "unchanged" | "updated";
  updatedNodeCount: number;
  updatedBridgeIds: string[];
}

export async function writeFigmaUpdatesToPen(
  document: BridgeDocument,
  changedBridgeIds: string[],
  mappings: PenBridgeMapping[],
  currentRoot: PenNode,
  assetData: Record<string, FigmaExportAssetData>,
  penPath: string,
  pen: PenMcpClient,
): Promise<PenUpdateResult> {
  if (!changedBridgeIds.length)
    return {
      operation: "unchanged",
      updatedNodeCount: 0,
      updatedBridgeIds: [],
    };
  if (changedBridgeIds.length > MAX_UPDATE_OPERATIONS)
    throw new Error(
      `Pencil update has ${changedBridgeIds.length} operations; the atomic limit is ${MAX_UPDATE_OPERATIONS}`,
    );
  const currentMappings = collectMappedPenBridgeMappings(currentRoot, mappings);
  assertStructureUnchanged(document, currentRoot, currentMappings);
  const assetPaths = await stageFigmaAssets(document, assetData, penPath);
  const plan = planFigmaToPenCreate(document, { assetPaths });
  const inserts = new Map(
    plan.operations
      .filter(
        (operation): operation is PenInsertOperation =>
          operation.type === "insert",
      )
      .map((operation) => [operation.bridgeId, operation]),
  );
  const penByBridgeId = new Map(
    mappings.map((mapping) => [mapping.bridgeId, mapping.penNodeId]),
  );
  const currentByBridgeId = flattenPenNodes(currentRoot, currentMappings);
  const statements: string[] = [];

  for (const bridgeId of changedBridgeIds) {
    const operation = inserts.get(bridgeId);
    const penNodeId = penByBridgeId.get(bridgeId);
    const current = currentByBridgeId.get(bridgeId);
    if (!operation || !penNodeId || !current)
      throw new Error(`Pencil update mapping missing ${bridgeId}`);
    const expectedType = operation.payload.type;
    if (typeof expectedType !== "string" || current.type !== expectedType)
      throw new Error(
        `Pencil node type change requires replacement: ${bridgeId} (${current.type} → ${String(expectedType)})`,
      );
    const payload = sanitizeUpdatePayload(
      operation.payload,
      bridgeId === document.root.bridgeId,
      document.root.name,
    );
    statements.push(
      `Update(${JSON.stringify(penNodeId)},${JSON.stringify(payload)})`,
      `Print("UPDATED","|",${JSON.stringify(bridgeId)},"|",${JSON.stringify(penNodeId)})`,
    );
  }
  const input = statements.join(";");
  if (input.length > MAX_UPDATE_BYTES)
    throw new Error(
      `Pencil update is ${input.length} bytes; the atomic limit is ${MAX_UPDATE_BYTES}`,
    );
  const output = await pen.executeWrite(input, 90_000);
  const updated = parseUpdatedMappings(output);
  for (const bridgeId of changedBridgeIds)
    if (!updated.has(bridgeId))
      throw new Error(`Pencil did not confirm update ${bridgeId}`);
  return {
    operation: "updated",
    updatedNodeCount: changedBridgeIds.length,
    updatedBridgeIds: [...changedBridgeIds],
  };
}

function sanitizeUpdatePayload(
  source: Record<string, unknown>,
  isRoot: boolean,
  rootName: string,
): Record<string, unknown> {
  const payload = { ...source };
  delete payload.type;
  delete payload.placeholder;
  delete payload.metadata;
  if (isRoot) {
    delete payload.x;
    delete payload.y;
    payload.name = `${rootName} · Figma Copy`;
  }
  return payload;
}

function assertStructureUnchanged(
  document: BridgeDocument,
  currentRoot: PenNode,
  mappings: PenBridgeMapping[],
): void {
  const expected: Array<{
    bridgeId: string;
    parentBridgeId: string | undefined;
    index: number;
  }> = [];
  const visitBridge = (
    node: BridgeDocument["root"],
    parentBridgeId: string | undefined,
    index: number,
  ) => {
    expected.push({ bridgeId: node.bridgeId, parentBridgeId, index });
    node.children.forEach((child, childIndex) =>
      visitBridge(child, node.bridgeId, childIndex),
    );
  };
  visitBridge(document.root, undefined, 0);
  const bridgeIdByPenNodeId = new Map(
    mappings.map((mapping) => [mapping.penNodeId, mapping.bridgeId]),
  );
  const actual: typeof expected = [];
  const visitPen = (
    node: PenNode,
    parentBridgeId: string | undefined,
    index: number,
  ) => {
    const bridgeId = bridgeIdByPenNodeId.get(node.id);
    if (!bridgeId) throw new Error(`Pencil node ${node.id} is not mapped`);
    actual.push({ bridgeId, parentBridgeId, index });
    (node.children ?? []).forEach((child, childIndex) =>
      visitPen(child, bridgeId, childIndex),
    );
  };
  visitPen(currentRoot, undefined, 0);
  if (expected.length !== actual.length)
    throw new Error("Structural sync requires create/delete support");
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index]!;
    const right = actual[index]!;
    if (
      left.bridgeId !== right.bridgeId ||
      left.parentBridgeId !== right.parentBridgeId ||
      left.index !== right.index
    )
      throw new Error(
        `Structural sync is not enabled yet: ${left.bridgeId} does not match ${right.bridgeId}`,
      );
  }
}

function flattenPenNodes(
  root: PenNode,
  mappings: PenBridgeMapping[],
): Map<string, PenNode> {
  const result = new Map<string, PenNode>();
  const bridgeIdByPenNodeId = new Map(
    mappings.map((mapping) => [mapping.penNodeId, mapping.bridgeId]),
  );
  const visit = (node: PenNode) => {
    const bridgeId = bridgeIdByPenNodeId.get(node.id);
    if (!bridgeId) throw new Error(`Pencil node ${node.id} is not mapped`);
    if (result.has(bridgeId))
      throw new Error(`Duplicate Pencil bridge identity ${bridgeId}`);
    result.set(bridgeId, node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return result;
}

function parseUpdatedMappings(output: string): Set<string> {
  const updated = new Set<string>();
  const pattern = /UPDATED\s*\|\s*([^|\r\n]+?)\s*\|\s*[A-Za-z0-9]+/g;
  for (const match of output.matchAll(pattern)) updated.add(match[1]!.trim());
  return updated;
}
