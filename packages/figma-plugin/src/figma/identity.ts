export const BRIDGE_ID_KEY = "penFigBridgeId";
export const AUTHORED_HASH_KEY = "penFigAuthoredHash";

export interface IdentityRecord {
  bridgeId: string;
  authoredHash: string;
  nodeId: string;
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
