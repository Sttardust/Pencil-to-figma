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

export interface PenStructuralUpdateResult extends PenUpdateResult {
  mappings: PenBridgeMapping[];
}

export async function writeFigmaUpdatesToPen(
  document: BridgeDocument,
  changedBridgeIds: string[],
  mappings: PenBridgeMapping[],
  currentRoot: PenNode,
  currentPenDocument: BridgeDocument,
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
  const penByBridgeId = collectPenNativeIds(currentPenDocument);
  for (const mapping of mappings)
    penByBridgeId.set(mapping.bridgeId, mapping.penNodeId);
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
    const payload = resolvePenReferences(
      sanitizeUpdatePayload(
        operation.payload,
        bridgeId === document.root.bridgeId,
        document.root.name,
      ),
      penByBridgeId,
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

export async function writeFigmaStructureToPen(
  document: BridgeDocument,
  changedBridgeIds: string[],
  mappings: PenBridgeMapping[],
  currentRoot: PenNode,
  currentPenDocument: BridgeDocument,
  assetData: Record<string, FigmaExportAssetData>,
  penPath: string,
  pen: PenMcpClient,
  options: { scopeBridgeIds?: ReadonlySet<string> } = {},
): Promise<PenStructuralUpdateResult> {
  const currentMappings = collectPresentPenBridgeMappings(
    currentRoot,
    mappings,
  );
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
  const current = describePenStructure(currentRoot, currentMappings);
  const expected = describeBridgeStructure(document);
  if (!current.has(document.root.bridgeId))
    throw new Error("Mapped Pencil root is missing");
  if (expected.get(document.root.bridgeId)?.parentBridgeId)
    throw new Error("Figma root cannot have a parent");

  const removed = new Set(
    [...current.keys()].filter(
      (bridgeId) =>
        !expected.has(bridgeId) &&
        (!options.scopeBridgeIds || options.scopeBridgeIds.has(bridgeId)),
    ),
  );
  const added = [...expected.values()].filter(
    (entry) =>
      !current.has(entry.bridgeId) &&
      (!options.scopeBridgeIds || options.scopeBridgeIds.has(entry.bridgeId)),
  );
  if (added.some((entry) => !entry.parentBridgeId))
    throw new Error("Replacing the mapped root is not supported");
  const topRemoved = [...removed].filter((bridgeId) => {
    const parentBridgeId = current.get(bridgeId)?.parentBridgeId;
    return !parentBridgeId || !removed.has(parentBridgeId);
  });
  const survivingMappings = currentMappings.filter(
    (mapping) => !removed.has(mapping.bridgeId),
  );
  const nativeByBridgeId = collectPenNativeIds(currentPenDocument);
  for (const mapping of survivingMappings)
    nativeByBridgeId.set(mapping.bridgeId, mapping.penNodeId);
  const variableByBridgeId = new Map<string, string>();
  const statements: string[] = [];
  let operationCount = 0;

  for (const bridgeId of topRemoved) {
    const nativeId = mappings.find(
      (mapping) => mapping.bridgeId === bridgeId,
    )?.penNodeId;
    if (!nativeId) throw new Error(`Pencil delete mapping missing ${bridgeId}`);
    statements.push(`Delete(${JSON.stringify(nativeId)})`);
    operationCount += 1;
  }

  for (const entry of added) {
    const operation = inserts.get(entry.bridgeId);
    if (!operation || !entry.parentBridgeId)
      throw new Error(`Pencil insert plan missing ${entry.bridgeId}`);
    const variable = `added_${variableByBridgeId.size}`;
    const payload = prepareStructuralInsertPayload(
      operation.payload,
      nativeByBridgeId,
    );
    statements.push(
      `let ${variable}=Insert(${nodeReference(entry.parentBridgeId, nativeByBridgeId, variableByBridgeId)},${JSON.stringify(payload)})`,
      `Print("MAP","|",${JSON.stringify(entry.bridgeId)},"|",${variable})`,
    );
    variableByBridgeId.set(entry.bridgeId, variable);
    operationCount += 1;
  }

  for (const bridgeId of changedBridgeIds) {
    if (removed.has(bridgeId) || variableByBridgeId.has(bridgeId)) continue;
    const operation = inserts.get(bridgeId);
    const currentEntry = current.get(bridgeId);
    if (!operation || !currentEntry)
      throw new Error(`Pencil update mapping missing ${bridgeId}`);
    const expectedType = operation.payload.type;
    if (
      typeof expectedType !== "string" ||
      currentEntry.node.type !== expectedType
    )
      throw new Error(
        `Pencil node type change requires replacement: ${bridgeId} (${currentEntry.node.type} → ${String(expectedType)})`,
      );
    const payload = resolvePenReferences(
      sanitizeUpdatePayload(
        operation.payload,
        bridgeId === document.root.bridgeId,
        document.root.name,
      ),
      nativeByBridgeId,
    );
    statements.push(
      `Update(${nodeReference(bridgeId, nativeByBridgeId, variableByBridgeId)},${JSON.stringify(payload)})`,
    );
    operationCount += 1;
  }

  for (const move of planRequiredMoves(
    current,
    expected,
    removed,
    added,
    options.scopeBridgeIds,
  )) {
    statements.push(
      `Move(${nodeReference(move.bridgeId, nativeByBridgeId, variableByBridgeId)},${nodeReference(move.parentBridgeId, nativeByBridgeId, variableByBridgeId)},${move.index})`,
    );
    operationCount += 1;
  }
  statements.push(
    `Print("STRUCTURE_UPDATED","|",${JSON.stringify(document.root.bridgeId)})`,
  );
  if (operationCount > MAX_UPDATE_OPERATIONS)
    throw new Error(
      `Pencil structural update has ${operationCount} operations; the atomic limit is ${MAX_UPDATE_OPERATIONS}`,
    );
  const input = statements.join(";");
  if (input.length > MAX_UPDATE_BYTES)
    throw new Error(
      `Pencil structural update is ${input.length} bytes; the atomic limit is ${MAX_UPDATE_BYTES}`,
    );
  const output = await pen.executeWrite(input, 90_000);
  if (!/STRUCTURE_UPDATED\s*\|/.test(output))
    throw new Error("Pencil did not confirm the structural update");
  const createdMappings = parseMappings(output).map((mapping) => ({
    bridgeId: mapping.bridgeId,
    penNodeId: mapping.nativeId,
  }));
  const createdByBridgeId = new Map(
    createdMappings.map((mapping) => [mapping.bridgeId, mapping.penNodeId]),
  );
  for (const entry of added)
    if (!createdByBridgeId.has(entry.bridgeId))
      throw new Error(`Pencil did not return an id for ${entry.bridgeId}`);
  return {
    operation: "updated",
    updatedNodeCount: changedBridgeIds.length,
    updatedBridgeIds: [...changedBridgeIds],
    mappings: [...survivingMappings, ...createdMappings],
  };
}

interface StructureEntry {
  bridgeId: string;
  parentBridgeId: string | undefined;
  index: number;
  node: PenNode;
}

function describePenStructure(
  root: PenNode,
  mappings: PenBridgeMapping[],
): Map<string, StructureEntry> {
  const bridgeIdByPenNodeId = new Map(
    mappings.map((mapping) => [mapping.penNodeId, mapping.bridgeId]),
  );
  const result = new Map<string, StructureEntry>();
  const visit = (
    node: PenNode,
    parentBridgeId: string | undefined,
    index: number,
  ) => {
    const bridgeId = bridgeIdByPenNodeId.get(node.id);
    if (!bridgeId) throw new Error(`Pencil node ${node.id} is not mapped`);
    result.set(bridgeId, { bridgeId, parentBridgeId, index, node });
    (node.children ?? []).forEach((child, childIndex) =>
      visit(child, bridgeId, childIndex),
    );
  };
  visit(root, undefined, 0);
  return result;
}

function collectPresentPenBridgeMappings(
  root: PenNode,
  expectedMappings: PenBridgeMapping[],
): PenBridgeMapping[] {
  const bridgeIdByPenNodeId = new Map(
    expectedMappings.map((mapping) => [mapping.penNodeId, mapping.bridgeId]),
  );
  const mappings: PenBridgeMapping[] = [];
  const bridgeIds = new Set<string>();
  const visit = (node: PenNode) => {
    const bridgeId = bridgeIdByPenNodeId.get(node.id);
    if (!bridgeId)
      throw new Error(`Pencil node ${node.id} is not in the sync manifest`);
    if (bridgeIds.has(bridgeId))
      throw new Error(`Duplicate Pencil bridge identity ${bridgeId}`);
    bridgeIds.add(bridgeId);
    mappings.push({ bridgeId, penNodeId: node.id });
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return mappings;
}

interface ExpectedStructureEntry {
  bridgeId: string;
  parentBridgeId: string | undefined;
  index: number;
}

function describeBridgeStructure(
  document: BridgeDocument,
): Map<string, ExpectedStructureEntry> {
  const result = new Map<string, ExpectedStructureEntry>();
  const visit = (
    node: BridgeDocument["root"],
    parentBridgeId: string | undefined,
    index: number,
  ) => {
    result.set(node.bridgeId, {
      bridgeId: node.bridgeId,
      parentBridgeId,
      index,
    });
    node.children.forEach((child, childIndex) =>
      visit(child, node.bridgeId, childIndex),
    );
  };
  visit(document.root, undefined, 0);
  return result;
}

function planRequiredMoves(
  current: Map<string, StructureEntry>,
  expected: Map<string, ExpectedStructureEntry>,
  removed: Set<string>,
  added: ExpectedStructureEntry[],
  scopeBridgeIds?: ReadonlySet<string>,
): Array<{ bridgeId: string; parentBridgeId: string; index: number }> {
  const children = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();
  for (const entry of current.values()) {
    if (!entry.parentBridgeId || removed.has(entry.bridgeId)) continue;
    const siblings = children.get(entry.parentBridgeId) ?? [];
    siblings.push(entry.bridgeId);
    children.set(entry.parentBridgeId, siblings);
    parentByChild.set(entry.bridgeId, entry.parentBridgeId);
  }
  for (const entry of added) {
    if (!entry.parentBridgeId) continue;
    const siblings = children.get(entry.parentBridgeId) ?? [];
    siblings.push(entry.bridgeId);
    children.set(entry.parentBridgeId, siblings);
    parentByChild.set(entry.bridgeId, entry.parentBridgeId);
  }
  const expectedChildren = new Map<string, string[]>();
  for (const entry of expected.values()) {
    if (!entry.parentBridgeId) continue;
    const siblings = expectedChildren.get(entry.parentBridgeId) ?? [];
    siblings.push(entry.bridgeId);
    expectedChildren.set(entry.parentBridgeId, siblings);
  }
  const moves: Array<{
    bridgeId: string;
    parentBridgeId: string;
    index: number;
  }> = [];
  for (const [parentBridgeId, target] of expectedChildren) {
    if (
      scopeBridgeIds &&
      !scopeBridgeIds.has(parentBridgeId) &&
      !target.some((bridgeId) => scopeBridgeIds.has(bridgeId))
    )
      continue;
    const siblings = children.get(parentBridgeId) ?? [];
    for (let index = 0; index < target.length; index += 1) {
      const bridgeId = target[index]!;
      if (siblings[index] === bridgeId) continue;
      const oldParent = parentByChild.get(bridgeId);
      if (!oldParent)
        throw new Error(`Pencil move mapping missing ${bridgeId}`);
      const oldSiblings = children.get(oldParent)!;
      const oldIndex = oldSiblings.indexOf(bridgeId);
      if (oldIndex < 0)
        throw new Error(`Pencil move source missing ${bridgeId}`);
      oldSiblings.splice(oldIndex, 1);
      siblings.splice(index, 0, bridgeId);
      children.set(parentBridgeId, siblings);
      parentByChild.set(bridgeId, parentBridgeId);
      moves.push({ bridgeId, parentBridgeId, index });
    }
  }
  return moves;
}

function prepareStructuralInsertPayload(
  source: Record<string, unknown>,
  nativeByBridgeId: Map<string, string>,
): Record<string, unknown> {
  const payload = { ...source };
  delete payload.placeholder;
  return resolvePenReferences(payload, nativeByBridgeId);
}

function collectPenNativeIds(document: BridgeDocument): Map<string, string> {
  const nativeIds = new Map<string, string>();
  const visit = (node: BridgeDocument["root"]) => {
    if (node.source.app === "pen")
      nativeIds.set(node.bridgeId, node.source.nodeId);
    for (const child of node.children) visit(child);
  };
  visit(document.root);
  for (const component of document.components ?? []) visit(component);
  return nativeIds;
}

function resolvePenReferences(
  source: Record<string, unknown>,
  nativeByBridgeId: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const payload = { ...source };
  if (typeof payload.ref === "string") {
    const mapped = nativeByBridgeId.get(payload.ref);
    if (!mapped) throw new Error(`Unresolved Figma component ${payload.ref}`);
    payload.ref = mapped;
  }
  if (
    payload.descendants &&
    typeof payload.descendants === "object" &&
    !Array.isArray(payload.descendants)
  ) {
    payload.descendants = Object.fromEntries(
      Object.entries(payload.descendants).map(([bridgeId, override]) => {
        const nativeId = nativeByBridgeId.get(bridgeId);
        if (!nativeId)
          throw new Error(`Unresolved Figma component child ${bridgeId}`);
        return [nativeId, override];
      }),
    );
  }
  return payload;
}

function nodeReference(
  bridgeId: string,
  nativeByBridgeId: Map<string, string>,
  variableByBridgeId: Map<string, string>,
): string {
  const variable = variableByBridgeId.get(bridgeId);
  if (variable) return variable;
  const nativeId = nativeByBridgeId.get(bridgeId);
  if (!nativeId) throw new Error(`Pencil mapping missing ${bridgeId}`);
  return JSON.stringify(nativeId);
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

function parseMappings(
  output: string,
): Array<{ bridgeId: string; nativeId: string }> {
  const mappings: Array<{ bridgeId: string; nativeId: string }> = [];
  const pattern = /MAP\s*\|\s*([^|\r\n]+?)\s*\|\s*([A-Za-z0-9]+)/g;
  for (const match of output.matchAll(pattern))
    mappings.push({ bridgeId: match[1]!.trim(), nativeId: match[2]! });
  return mappings;
}
