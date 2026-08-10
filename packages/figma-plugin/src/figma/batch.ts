import { authoredDocumentHashes } from "@pen-fig/core";
import {
  bridgeDocumentSchema,
  type BridgeDocument,
  type BridgeNode,
} from "@pen-fig/bridge-schema";
import type { FigmaReadResult } from "./read.js";

export const MAX_PENCIL_IMPORT_SCREENS = 50;
export const MAX_PENCIL_IMPORT_NODES = 5_000;
export const MAX_PENCIL_IMPORT_ASSET_BYTES = 64 * 1024 * 1024;

export interface ExportPlanCounts {
  assets: number;
  inserts: number;
  finalizes: number;
}

export function validateFigmaExportBatch(results: FigmaReadResult[]): void {
  const totalNodes = results.reduce(
    (total, result) => total + result.nodeCount,
    0,
  );
  if (totalNodes > 5_000)
    throw new Error(
      `The selected screens contain ${totalNodes} editable layers. Send a smaller batch of 5,000 layers or fewer.`,
    );

  let totalAssetBytes = 0;
  for (const result of results) {
    let screenAssetBytes = 0;
    for (const asset of Object.values(result.assetData)) {
      if (asset.byteLength > 10 * 1024 * 1024)
        throw new Error(
          `“${result.document.root.name}” contains an image larger than 10 MiB. Compress that image before sending it.`,
        );
      screenAssetBytes += asset.byteLength;
    }
    if (screenAssetBytes > 32 * 1024 * 1024)
      throw new Error(
        `“${result.document.root.name}” contains more than 32 MiB of images. Compress its images before sending it.`,
      );
    totalAssetBytes += screenAssetBytes;
  }
  if (totalAssetBytes > 64 * 1024 * 1024)
    throw new Error(
      "The selected screens contain more than 64 MiB of images. Send fewer screens at once.",
    );

  const bridgeOwner = new Map<string, string>();
  for (const result of results) {
    const name = result.document.root.name;
    for (const bridgeId of Object.keys(
      authoredDocumentHashes(result.document),
    )) {
      const owner = bridgeOwner.get(bridgeId);
      if (owner)
        throw new Error(
          `“${owner}” and “${name}” share copied bridge identities. Export them separately or recreate one copy before linking them.`,
        );
      bridgeOwner.set(bridgeId, name);
    }
  }
}

export function sumExportPlanCounts(
  counts: ExportPlanCounts[],
): ExportPlanCounts {
  return counts.reduce(
    (total, current) => ({
      assets: total.assets + current.assets,
      inserts: total.inserts + current.inserts,
      finalizes: total.finalizes + current.finalizes,
    }),
    { assets: 0, inserts: 0, finalizes: 0 },
  );
}

export interface PencilImportBatchSummary {
  documents: BridgeDocument[];
  nodeCount: number;
  assetBytes: number;
}

export function validatePencilImportBatch(
  inputs: unknown[],
): PencilImportBatchSummary {
  if (!inputs.length)
    throw new Error("Select at least one Pencil page to send to Figma.");
  if (inputs.length > MAX_PENCIL_IMPORT_SCREENS)
    throw new Error(
      `Select no more than ${MAX_PENCIL_IMPORT_SCREENS} Pencil pages at once.`,
    );

  const documents = inputs.map((input) => bridgeDocumentSchema.parse(input));
  const rootOwners = new Map<string, string>();
  let nodeCount = 0;
  let assetBytes = 0;
  for (const document of documents) {
    const previousOwner = rootOwners.get(document.root.bridgeId);
    if (previousOwner)
      throw new Error(
        `“${previousOwner}” and “${document.root.name}” refer to the same Pencil page. Select each page once.`,
      );
    rootOwners.set(document.root.bridgeId, document.root.name);
    nodeCount += countBridgeNodes(document.root);
    for (const component of document.components ?? [])
      nodeCount += countBridgeNodes(component);
    assetBytes += document.assets.reduce(
      (total, asset) =>
        total + (asset.status === "ready" ? asset.byteLength : 0),
      0,
    );
  }

  if (nodeCount > MAX_PENCIL_IMPORT_NODES)
    throw new Error(
      `The selected Pencil pages contain ${nodeCount} editable layers. Send a smaller batch of ${MAX_PENCIL_IMPORT_NODES.toLocaleString()} layers or fewer.`,
    );
  if (assetBytes > MAX_PENCIL_IMPORT_ASSET_BYTES)
    throw new Error(
      "The selected Pencil pages contain more than 64 MiB of images. Send fewer pages at once.",
    );
  return { documents, nodeCount, assetBytes };
}

function countBridgeNodes(node: BridgeNode): number {
  return (
    1 +
    node.children.reduce((total, child) => total + countBridgeNodes(child), 0)
  );
}
