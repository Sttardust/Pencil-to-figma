export const BRIDGE_ID_KEY = "penFigBridgeId";
export const AUTHORED_HASH_KEY = "penFigAuthoredHash";
export const BRIDGE_KIND_KEY = "penFigBridgeKind";
export const SVG_ASSET_KEY = "penFigSvgAssetId";
export const INSTANCE_OVERRIDE_MAP_KEY = "penFigInstanceOverrideMap";

export interface IdentityRecord {
  bridgeId: string;
  authoredHash: string;
  nodeId: string;
}

export interface MappedSubtree {
  records: Array<{
    bridgeId: string;
    nodeId: string;
    parentBridgeId: string | undefined;
    index: number;
    authoredHash: string;
  }>;
  nodes: Map<string, SceneNode>;
}

export type IdentityState =
  | { status: "new" }
  | { status: "unchanged" }
  | {
      status: "changed";
      missingBridgeIds: string[];
      changedBridgeIds: string[];
    };

export function classifyIdentities(
  expectedHashes: Record<string, string>,
  existing: IdentityRecord[],
): IdentityState {
  const expectedIds = new Set(Object.keys(expectedHashes));
  const relevant = existing.filter((record) =>
    expectedIds.has(record.bridgeId),
  );
  if (relevant.length === 0) return { status: "new" };

  const byBridgeId = new Map<string, IdentityRecord[]>();
  for (const record of relevant) {
    const matches = byBridgeId.get(record.bridgeId) ?? [];
    matches.push(record);
    byBridgeId.set(record.bridgeId, matches);
  }
  const duplicates = [...byBridgeId.entries()].filter(
    ([, matches]) => matches.length > 1,
  );
  if (duplicates.length) {
    const details = duplicates
      .slice(0, 5)
      .map(
        ([bridgeId, matches]) =>
          `${bridgeId} (${matches.map((match) => match.nodeId).join(", ")})`,
      )
      .join("; ");
    throw new Error(
      `Duplicate bridge identities require remapping: ${details}`,
    );
  }

  const missingBridgeIds: string[] = [];
  const changedBridgeIds: string[] = [];
  for (const [bridgeId, expectedHash] of Object.entries(expectedHashes)) {
    const match = byBridgeId.get(bridgeId)?.[0];
    if (!match) missingBridgeIds.push(bridgeId);
    else if (match.authoredHash !== expectedHash)
      changedBridgeIds.push(bridgeId);
  }
  return missingBridgeIds.length === 0 && changedBridgeIds.length === 0
    ? { status: "unchanged" }
    : { status: "changed", missingBridgeIds, changedBridgeIds };
}

export function readPageIdentities(page: PageNode): IdentityRecord[] {
  return page
    .findAll((node) => node.getPluginData(BRIDGE_ID_KEY) !== "")
    .map((node) => ({
      bridgeId: node.getPluginData(BRIDGE_ID_KEY),
      authoredHash: node.getPluginData(AUTHORED_HASH_KEY),
      nodeId: node.id,
    }));
}

export function findMappedRoots(page: PageNode, bridgeId: string): SceneNode[] {
  return page.findAll((node) => node.getPluginData(BRIDGE_ID_KEY) === bridgeId);
}

export function readMappedSubtree(root: SceneNode): MappedSubtree {
  const sceneNodes: SceneNode[] = [];
  const collect = (node: SceneNode) => {
    if (node.getPluginData(BRIDGE_ID_KEY) !== "") sceneNodes.push(node);
    if (node.type === "INSTANCE" || !("children" in node)) return;
    for (const child of node.children) collect(child);
  };
  collect(root);
  const nodes = new Map<string, SceneNode>();
  const records: MappedSubtree["records"] = [];
  for (const node of sceneNodes) {
    const bridgeId = node.getPluginData(BRIDGE_ID_KEY);
    if (!bridgeId) continue;
    if (nodes.has(bridgeId))
      throw new Error(`Duplicate bridge identity ${bridgeId}`);
    nodes.set(bridgeId, node);
    const parent = node.parent;
    const parentBridgeId =
      parent && "getPluginData" in parent
        ? parent.getPluginData(BRIDGE_ID_KEY) || undefined
        : undefined;
    const mappedSiblings =
      parent && "children" in parent
        ? parent.children.filter(
            (child) => child.getPluginData(BRIDGE_ID_KEY) !== "",
          )
        : [node];
    records.push({
      bridgeId,
      nodeId: node.id,
      parentBridgeId,
      index: mappedSiblings.indexOf(node),
      authoredHash: node.getPluginData(AUTHORED_HASH_KEY),
    });
  }
  return { records, nodes };
}
